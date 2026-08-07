/**
 * Live WebSocket validation executed in the RENDERER.
 *
 * The main process's global WebSocket (Node/undici) dials with Node's TLS
 * stack and can never present an mTLS client certificate: certificate
 * selection happens inside Chromium sessions via the
 * ``select-client-certificate`` handler, and a YubiHSM-backed identity's
 * private key cannot be extracted to the main process at all. A gateway that
 * requires a client certificate therefore rejects the main-process probe at
 * the TLS layer while the HTTP status leg (routed through the Electron
 * session) and the renderer's real chat WebSocket both succeed.
 *
 * So when a connection has a client certificate configured, the live-WS leg
 * of the "Test remote" check runs HERE: the renderer's WebSocket goes through
 * the same session/transport as the actual chat connection — exactly what
 * the probe exists to validate.
 *
 * ``rendererWsProbeScript`` builds a self-contained async IIFE whose
 * classification mirrors ``probeGatewayWebSocket`` (open → grace window,
 * frame → success, error → fail, close → pre/post-open classification,
 * connect timeout). ``probeGatewayWebSocketInRenderer`` executes it in a
 * live webContents and returns ``null`` when there is no renderer to run it
 * in (callers then skip the WS leg — the HTTP status check has already
 * verified reachability with the real credentials, and boot validates the
 * renderer WebSocket anyway).
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_READY_GRACE_MS = 750

function rendererWsProbeScript(wsUrl, connectTimeoutMs, readyGraceMs) {
  return `(function () {
  const url = ${JSON.stringify(wsUrl)}
  const connectTimeoutMs = ${Number(connectTimeoutMs) || 0}
  const readyGraceMs = ${Number(readyGraceMs) || 0}
  return new Promise(function (resolve) {
    let settled = false
    let opened = false
    let connectTimer = null
    let graceTimer = null
    let socket

    function clearTimers() {
      if (connectTimer !== null) {
        clearTimeout(connectTimer)
        connectTimer = null
      }
      if (graceTimer !== null) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
    }

    function finish(result) {
      if (settled) {
        return
      }
      settled = true
      clearTimers()
      try {
        socket && socket.close()
      } catch (ignored) {}
      resolve(result)
    }

    try {
      socket = new WebSocket(url)
    } catch (error) {
      finish({ ok: false, reason: String(error) })
      return
    }

    socket.addEventListener('open', function () {
      if (settled) {
        return
      }
      opened = true
      graceTimer = setTimeout(function () {
        finish({ ok: true })
      }, readyGraceMs)
    })

    socket.addEventListener('message', function () {
      finish({ ok: true })
    })

    socket.addEventListener('error', function () {
      finish({ ok: false, reason: 'WebSocket connection failed.' })
    })

    socket.addEventListener('close', function (event) {
      if (settled) {
        return
      }
      const code = event && typeof event.code === 'number' ? event.code : null
      const suffix = code ? ' (code ' + code + ')' : ''
      if (opened) {
        finish({
          ok: false,
          reason: 'The gateway accepted the connection then closed it (credential rejected?)' + suffix
        })
        return
      }
      finish({ ok: false, reason: 'The gateway closed the WebSocket before it opened.' + suffix })
    })

    if (connectTimeoutMs > 0) {
      connectTimer = setTimeout(
        function () {
          finish({
            ok: false,
            reason: 'Timed out after ' + connectTimeoutMs + 'ms waiting for the WebSocket to open.'
          })
        },
        connectTimeoutMs
      )
    }
  })
})()`
}

/**
 * Run the live-WS probe in the given webContents (the app's renderer).
 *
 * @param {any} webContents - Electron WebContents, or null/undefined.
 * @param {string} wsUrl - Fully-formed ws(s):// URL including the credential.
 * @returns {Promise<{ ok: boolean, reason?: string } | null>} Probe result, or
 *   null when there is no usable renderer to run it in.
 */
async function probeGatewayWebSocketInRenderer(webContents, wsUrl, connectTimeoutMs?, readyGraceMs?) {
  const timeoutMs = connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const graceMs = readyGraceMs ?? DEFAULT_READY_GRACE_MS

  if (!webContents || typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) {
    return null
  }
  if (typeof webContents.executeJavaScript !== 'function') {
    return null
  }

  try {
    const result = await webContents.executeJavaScript(rendererWsProbeScript(wsUrl, timeoutMs, graceMs), true)

    return result && typeof result === 'object' ? result : null
  } catch {
    // Renderer mid-navigation, destroyed, or crashed — the probe is best
    // effort; callers treat null as "WS leg not verifiable from here".
    return null
  }
}

export { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_READY_GRACE_MS, probeGatewayWebSocketInRenderer, rendererWsProbeScript }
