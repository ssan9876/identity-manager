import 'reflect-metadata'
import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('runs TypeScript with decorator metadata enabled', () => {
    function Marker(): ParameterDecorator {
      return () => {}
    }

    class Probe {
      constructor(@Marker() param: string) {}
    }

    const paramTypes = Reflect.getMetadata('design:paramtypes', Probe)
    expect(paramTypes).toBeDefined()
    expect(paramTypes[0]).toBe(String)
  })
})
