import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { beforeEach, describe, it } from 'node:test';

describe('UsersController', () => {
  let controller: UsersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('should be defined', () => {
    // expect(controller).toBeDefined();
  });
});
function expect(controller: UsersController) {
  throw new Error('Function not implemented.');
}

