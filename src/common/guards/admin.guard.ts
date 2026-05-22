import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { UserRole } from '../../modules/users/user.entity';

type AuthenticatedRequest = {
  user?: {
    role?: UserRole;
  };
};

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.user?.role === UserRole.ADMIN) {
      return true;
    }

    throw new ForbiddenException('Admin access required');
  }
}
