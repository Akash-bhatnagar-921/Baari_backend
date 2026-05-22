import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Subscription } from './subscription.entity';
import { User } from './user.entity';
import { UsersService } from './users.service';
import { Wishlist } from './wishlist.entity';

describe('UsersService', () => {
  let service: UsersService;
  const repository = {
    create: jest.fn(),
    delete: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: repository },
        { provide: getRepositoryToken(Wishlist), useValue: repository },
        { provide: getRepositoryToken(Subscription), useValue: repository },
        { provide: DataSource, useValue: { query: jest.fn() } },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
