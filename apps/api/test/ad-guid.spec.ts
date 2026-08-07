import { describe, expect, it } from 'vitest'
import {
  escapeDnValue,
  escapeFilterValue,
  guidBufferToFilterHex,
  guidBufferToString,
  guidStringToBuffer,
  guidStringToFilterHex,
} from '../src/connectors/ad-guid'

describe('ad-guid (Milestone 11, Task 5) — pure, no I/O', () => {
  describe('escapeDnValue', () => {
    it('leaves an ordinary value untouched', () => {
      expect(escapeDnValue('probe.user')).toBe('probe.user')
    })

    it('escapes RFC 4514 special characters anywhere in the value', () => {
      expect(escapeDnValue('a,b')).toBe('a\\,b')
      expect(escapeDnValue('a+b')).toBe('a\\+b')
      expect(escapeDnValue('a"b')).toBe('a\\"b')
      expect(escapeDnValue('a;b')).toBe('a\\;b')
      expect(escapeDnValue('a<b>c')).toBe('a\\<b\\>c')
      expect(escapeDnValue('a\\b')).toBe('a\\\\b')
    })

    it('escapes a leading space, leading #, and trailing space, but not an interior one', () => {
      expect(escapeDnValue(' leading')).toBe('\\ leading')
      expect(escapeDnValue('#leading')).toBe('\\#leading')
      expect(escapeDnValue('trailing ')).toBe('trailing\\ ')
      expect(escapeDnValue('mid dle')).toBe('mid dle')
    })

    it('escapes an embedded NUL byte', () => {
      expect(escapeDnValue('a\0b')).toBe('a\\00b')
    })
  })

  describe('escapeFilterValue', () => {
    it('leaves an ordinary value untouched', () => {
      expect(escapeFilterValue('probe.user')).toBe('probe.user')
    })

    it('escapes RFC 4515 special characters', () => {
      expect(escapeFilterValue('a*b')).toBe('a\\2ab')
      expect(escapeFilterValue('a(b)')).toBe('a\\28b\\29')
      expect(escapeFilterValue('a\\b')).toBe('a\\5cb')
      expect(escapeFilterValue('a\0b')).toBe('a\\00b')
    })

    it('passes non-ASCII text through unescaped', () => {
      expect(escapeFilterValue('café')).toBe('café')
    })
  })

  describe('guidBufferToFilterHex', () => {
    it('renders raw bytes as a backslash-hex-escaped LDAP filter value', () => {
      const buf = Buffer.from([0x00, 0xff, 0x1a, 0xb2])
      expect(guidBufferToFilterHex(buf)).toBe('\\00\\ff\\1a\\b2')
    })
  })

  describe('guidBufferToString / guidStringToBuffer — the mixed-endian objectGUID convention', () => {
    it('converts a known byte sequence to the standard dashed GUID string', () => {
      // Data1=0x03020100 (LE bytes 0-3), Data2=0x0504 (LE bytes 4-5),
      // Data3=0x0706 (LE bytes 6-7), Data4=08..0f (raw, as-is).
      const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f])
      expect(guidBufferToString(buf)).toBe('03020100-0504-0706-0809-0a0b0c0d0e0f')
    })

    it('round-trips buffer -> string -> buffer for arbitrary bytes, including 0x00 and 0xff', () => {
      const buf = Buffer.from([0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00])
      const str = guidBufferToString(buf)
      expect(guidStringToBuffer(str)).toEqual(buf)
    })

    it('round-trips string -> buffer -> string, case-insensitively on input', () => {
      const upper = 'AABBCCDD-EEFF-0011-2233-445566778899'
      const buf = guidStringToBuffer(upper)
      expect(guidBufferToString(buf)).toBe(upper.toLowerCase())
    })

    it('rejects a buffer of the wrong length', () => {
      expect(() => guidBufferToString(Buffer.from([1, 2, 3]))).toThrow(/16 bytes/)
    })

    it('rejects a malformed GUID string', () => {
      expect(() => guidStringToBuffer('not-a-guid')).toThrow(/not a valid objectGUID string/)
      expect(() => guidStringToBuffer('aabbccdd-eeff-0011-2233-4455667788')).toThrow(
        /not a valid objectGUID string/,
      )
    })
  })

  describe('guidStringToFilterHex', () => {
    it('composes the string->buffer and buffer->filter-hex steps', () => {
      const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f])
      const str = guidBufferToString(buf)
      expect(guidStringToFilterHex(str)).toBe(guidBufferToFilterHex(buf))
    })
  })
})
