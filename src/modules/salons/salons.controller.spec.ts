import { Test, TestingModule } from '@nestjs/testing';
import { SalonsController } from './salons.controller';

describe('SalonsController', () => {
  let controller: SalonsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SalonsController],
    }).compile();

    controller = module.get<SalonsController>(SalonsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
