import { describe, expect, it } from 'vitest'

import {
  certificateHostMatches,
  certificateIdentity,
  certificateMatchesFilters,
  chooseClientCertificate,
  filtersFromEnv,
  normalizeSerial
} from './client-certificate-selection'

const gatewayCertificate = {
  fingerprint: 'AA:BB:CC:DD',
  issuerName: 'Hermes Gateway CA',
  serialNumber: '64:44:82:AE',
  subjectName: 'CN=phillip-hermes'
}

const otherCertificate = {
  fingerprint: '11:22:33:44',
  issuerName: 'Example CA',
  serialNumber: 'AA:BB',
  subjectName: 'CN=example'
}

describe('client certificate selection', () => {
  it('normalizes serial values', () => {
    expect(normalizeSerial('64:44:82:ae')).toBe('644482ae')
  })

  it('identifies certificates by fingerprint', () => {
    expect(certificateIdentity(gatewayCertificate)).toBe('fingerprint:aabbccdd')
  })

  it('selects one candidate and declines ambiguity', () => {
    expect(chooseClientCertificate([gatewayCertificate])).toBe(gatewayCertificate)
    expect(chooseClientCertificate([gatewayCertificate, otherCertificate])).toBeNull()
  })

  it('selects by exact fingerprint and combined metadata filters', () => {
    expect(
      chooseClientCertificate([gatewayCertificate, otherCertificate], {
        autoSelect: true,
        fingerprint: 'aa:bb:cc:dd',
        issuer: 'gateway ca',
        serial: '644482ae',
        subject: 'phillip-hermes'
      })
    ).toBe(gatewayCertificate)
    expect(certificateMatchesFilters(gatewayCertificate, { serial: 'deadbeef' })).toBe(false)
  })

  it('parses environment filters without exposing certificate material', () => {
    expect(
      filtersFromEnv({
        HERMES_DESKTOP_CLIENT_CERT_AUTO_SELECT: '1',
        HERMES_DESKTOP_CLIENT_CERT_FINGERPRINT: 'AA:BB',
        HERMES_DESKTOP_CLIENT_CERT_ISSUER: ' Hermes Gateway CA ',
        HERMES_DESKTOP_CLIENT_CERT_SERIAL: '64:44:82:AE',
        HERMES_DESKTOP_CLIENT_CERT_SUBJECT: ' phillip-hermes '
      })
    ).toEqual({
      autoSelect: true,
      fingerprint: 'aabb',
      issuer: 'hermes gateway ca',
      serial: '644482ae',
      subject: 'phillip-hermes'
    })
  })

  it('matches exact hosts and safe subdomains but rejects lookalikes', () => {
    expect(certificateHostMatches('https://gateway.example.com/api/status', ['gateway.example.com'])).toBe(true)
    expect(certificateHostMatches('https://sub.gateway.example.com/api/status', ['gateway.example.com'])).toBe(true)
    expect(certificateHostMatches('https://gateway.example.com.evil.test/api/status', ['gateway.example.com'])).toBe(false)
  })
})
