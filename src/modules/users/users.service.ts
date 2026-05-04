import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { User, UserRole } from './user.entity';
import { Repository } from 'typeorm';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
  ) {}

  async createUser(phone: string, role: UserRole) {
    const user = this.userRepo.create({ phone, role });
    return this.userRepo.save(user);
  }

  async findByPhone(phone: string) {
    return this.userRepo.findOne({ where: { phone } });
  }

  async updateProfile(userId: string, data: any) {
    await this.userRepo.update(userId, data);
    return { message: 'Profile updated' };
  }
}
