import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('runs TypeScript with decorator metadata enabled', () => {
    function Marker(): ClassDecorator {
      return (target) => {
        Reflect.defineMetadata('marker', 'present', target)
      }
    }

    @Marker()
    class Probe {}

    expect(Reflect.getMetadata('marker', Probe)).toBe('present')
  })
})
