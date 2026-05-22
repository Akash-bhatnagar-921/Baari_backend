import { Test, TestingModule } from '@nestjs/testing';
import { SalonsController } from './salons.controller';
import { SalonsService } from './salons.service';

describe('SalonsController', () => {
  let controller: SalonsController;
  const salonsService = {
    createSalon: jest.fn(),
    verifySalonCode: jest.fn(),
    getMySalons: jest.fn(),
    getMySalonConfig: jest.fn(),
    updateMySalonServices: jest.fn(),
    updateMySalonAmenities: jest.fn(),
    searchFranchises: jest.fn(),
    searchSalons: jest.fn(),
    seedServices: jest.fn(),
    getServices: jest.fn(),
    seedAmenities: jest.fn(),
    getAmenities: jest.fn(),
    getAllSalons: jest.fn(),
    approveSalon: jest.fn(),
    toggleSalonOpen: jest.fn(),
    updateMyLocation: jest.fn(),
    syncMissingGeocodesAdmin: jest.fn(),
    updateWorkingHours: jest.fn(),
    getMyReviews: jest.fn(),
    getMyBarbers: jest.fn(),
    addBarber: jest.fn(),
    deleteBarber: jest.fn(),
    getSalonReviews: jest.fn(),
    getSalonById: jest.fn(),
    submitReview: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SalonsController],
      providers: [{ provide: SalonsService, useValue: salonsService }],
    }).compile();

    controller = module.get<SalonsController>(SalonsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
