import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from '../users/users.service';

describe('UsersController', () => {
  let controller: UsersController;
  const usersService = {
    updateProfile: jest.fn(),
    getProfile: jest.fn(),
    deleteAccount: jest.fn(),
    getSubscription: jest.fn(),
    createSubscription: jest.fn(),
    cancelSubscription: jest.fn(),
    getWishlist: jest.fn(),
    getWishlistIds: jest.fn(),
    addToWishlist: jest.fn(),
    removeFromWishlist: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
