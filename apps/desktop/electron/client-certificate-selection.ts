export interface ClientCertificate {
  fingerprint?: string
  issuerName?: string
  serialNumber?: string
  subjectName?: string
}

export interface ClientCertificateFilters {
  autoSelect: boolean
  fingerprint: string
  issuer: string
  serial: string
  subject: string
}

function normalized(value: unknown): string {
  return String(value || '').trim()
}

export function certificateHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function certificateHostMatches(rawUrl: string, allowedHosts: string[]): boolean {
  const hostname = certificateHost(rawUrl)

  return Boolean(
    hostname &&
      allowedHosts.some(rawHost => {
        const host = normalized(rawHost).toLowerCase()

        return host && (hostname === host || hostname.endsWith(`.${host}`))
      })
  )
}

export function normalizeFingerprint(value: unknown): string {
  return normalized(value).replace(/[^a-z0-9]/gi, '').toLowerCase()
}

export function normalizeSerial(value: unknown): string {
  return normalizeFingerprint(value)
}

export function certificateIdentity(certificate: ClientCertificate | null | undefined): string {
  const fingerprint = normalizeFingerprint(certificate?.fingerprint)

  if (fingerprint) {
    return `fingerprint:${fingerprint}`
  }

  const serial = normalizeSerial(certificate?.serialNumber)

  return serial ? `serial:${serial}` : ''
}

export function filtersFromEnv(env: Record<string, unknown> = process.env): ClientCertificateFilters {
  return {
    autoSelect: String(env.HERMES_DESKTOP_CLIENT_CERT_AUTO_SELECT || '1') !== '0',
    fingerprint: normalizeFingerprint(env.HERMES_DESKTOP_CLIENT_CERT_FINGERPRINT),
    issuer: normalized(env.HERMES_DESKTOP_CLIENT_CERT_ISSUER).toLowerCase(),
    serial: normalizeSerial(env.HERMES_DESKTOP_CLIENT_CERT_SERIAL),
    subject: normalized(env.HERMES_DESKTOP_CLIENT_CERT_SUBJECT).toLowerCase()
  }
}

export function filtersFromConfig(config: Partial<ClientCertificateFilters> = {}): ClientCertificateFilters {
  return {
    autoSelect: config.autoSelect !== false,
    fingerprint: normalizeFingerprint(config.fingerprint),
    issuer: normalized(config.issuer).toLowerCase(),
    serial: normalizeSerial(config.serial),
    subject: normalized(config.subject).toLowerCase()
  }
}

export function certificateMatchesFilters(
  certificate: ClientCertificate | null | undefined,
  filters: Partial<ClientCertificateFilters> = {}
): boolean {
  const subject = normalized(certificate?.subjectName).toLowerCase()
  const issuer = normalized(certificate?.issuerName).toLowerCase()

  if (filters.subject && !subject.includes(filters.subject.toLowerCase())) {
    return false
  }

  if (filters.issuer && !issuer.includes(filters.issuer.toLowerCase())) {
    return false
  }

  if (filters.serial && normalizeSerial(certificate?.serialNumber) !== normalizeSerial(filters.serial)) {
    return false
  }

  if (
    filters.fingerprint &&
    normalizeFingerprint(certificate?.fingerprint) !== normalizeFingerprint(filters.fingerprint)
  ) {
    return false
  }

  return true
}

export function chooseClientCertificate(
  candidates: ClientCertificate[] | null | undefined,
  filters: ClientCertificateFilters = filtersFromEnv()
): ClientCertificate | null {
  if (!filters.autoSelect) {
    return null
  }

  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : []
  const explicit = Boolean(filters.fingerprint || filters.issuer || filters.serial || filters.subject)
  const matches = explicit ? list.filter(candidate => certificateMatchesFilters(candidate, filters)) : list

  return matches.length === 1 ? matches[0] : null
}

export function certificateDisplayName(certificate: ClientCertificate | null | undefined): string {
  return certificate?.subjectName || certificate?.issuerName || certificate?.serialNumber || 'unknown certificate'
}
