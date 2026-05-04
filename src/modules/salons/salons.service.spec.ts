import { Test, TestingModule } from '@nestjs/testing';
import { SalonsService } from './salons.service';

describe('SalonsService', () => {
  let service: SalonsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SalonsService],
    }).compile();

    service = module.get<SalonsService>(SalonsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
