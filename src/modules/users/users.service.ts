import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { User } from './user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
  ) {}

  async createUser(data: any): Promise<User> {
    console.log('Register data', data);
    const user = this.userRepo.create(data);
    const savedUser = await this.userRepo.save(user);

    if (Array.isArray(savedUser)) {
      throw new Error('Unexpected array returned');
    }

    return savedUser;
  }

  async findByPhone(phone: string) {
    return this.userRepo.findOne({ where: { phone } });
  }

  async findByEmail(email: string) {
    return this.userRepo.findOne({ where: { email } });
  }

  async findByPhoneOrEmail(phone: string, email: string) {
    const where: FindOptionsWhere<User>[] = [{ phone }];

    if (email) {
      where.push({ email });
    }

    return this.userRepo.findOne({ where });
  }

  async updateProfile(userId: string, data: any) {
    await this.userRepo.update(userId, data);
    return { message: 'Profile updated' };
  }

  async getProfile(userId: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
    });

    console.log('user', user);

    if (!user) {
      throw new Error('User not found');
    }

    return user;
  }
}
