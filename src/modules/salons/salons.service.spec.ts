import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { EmailQueueService } from '../auth/services/email-queue.service';
import { SalonsService } from './salons.service';

describe('SalonsService', () => {
  let service: SalonsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalonsService,
        { provide: DataSource, useValue: {} },
        { provide: JwtService, useValue: { sign: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: EmailQueueService, useValue: {} },
      ],
    }).compile();

    service = module.get<SalonsService>(SalonsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
