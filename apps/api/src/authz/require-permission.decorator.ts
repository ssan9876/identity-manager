import { SetMetadata } from '@nestjs/common'
import type { Action } from './actions'

export const REQUIRED_PERMISSION = 'idm:required_permission'

/** Declares the permission a route requires. Routes without one are denied. */
export const RequirePermission = (action: Action): MethodDecorator =>
  SetMetadata(REQUIRED_PERMISSION, action)
