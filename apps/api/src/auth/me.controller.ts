import { Controller, Get, Req, UseGuards } from '@nestjs/common'
import { JwtGuard, type AuthenticatedRequest, type Principal } from './jwt.guard'

@Controller('me')
@UseGuards(JwtGuard)
export class MeController {
  @Get()
  me(@Req() request: AuthenticatedRequest): Principal {
    return request.principal
  }
}
