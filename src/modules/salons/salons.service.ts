import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Salon } from './entities/salon.entity';
import { SalonService } from './entities/salon-service.entity';
import { Barber } from './entities/barber.entity';
import { SalonAmenity } from './entities/salon-amenity.entity';

@Injectable()
export class SalonsService {
  constructor(private dataSource: DataSource) {}

  async createSalon(data: any) {
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const salon = queryRunner.manager.create(Salon, {
        name: data.name,
        address: data.address,
        // owner: { id: user.userId },
      });

      const savedSalon = await queryRunner.manager.save(salon);

      for (const s of data.services) {
        const ss = queryRunner.manager.create(SalonService, {
          salon: savedSalon,
          service: { id: s.serviceId },
          price: s.price,
          duration: s.duration,
        });

        await queryRunner.manager.save(ss);
      }

      // 3. Insert amenities
      if (data.amenities && data.amenities.length > 0) {
        for (const amenityId of data.amenities) {
          const sa = queryRunner.manager.create(SalonAmenity, {
            salon: savedSalon,
            amenity: { id: amenityId },
          });

          await queryRunner.manager.save(sa);
        }
      }

      for (const b of data.barbers) {
        const barber = queryRunner.manager.create(Barber, {
          salon: savedSalon,
          name: b.name,
          experience: b.experience,
        });

        await queryRunner.manager.save(barber);
      }

      await queryRunner.commitTransaction();
      return {
        message:
          'Salon submitted successfully. Review will take up to 24 hours.',
        status: 'pending',
        salonId: savedSalon.id,
      };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async seedServices() {
    const services = [
      'Haircut',
      'Beard Trim',
      'Hair Color',
      'Facial',
      'Shave',
      'Head Massage',
    ];

    for (const name of services) {
      await this.dataSource.query(
        `INSERT INTO services (id, name)
       VALUES (gen_random_uuid(), $1)
       ON CONFLICT (name) DO NOTHING`,
        [name],
      );
    }

    return { message: 'Services seeded' };
  }

  async getServices() {
    return this.dataSource.query(`SELECT * FROM services`);
  }

  async seedAmenities() {
    const amenities = [
      'AC',
      'Parking',
      'WiFi',
      'TV',
      'Card Payment',
      'Waiting Area',
    ];

    for (const name of amenities) {
      await this.dataSource.query(
        `INSERT INTO amenities (id, name)
       VALUES (gen_random_uuid(), $1)
       ON CONFLICT (name) DO NOTHING`,
        [name],
      );
    }

    return { message: 'Amenities seeded' };
  }

  async getAmenities() {
    return this.dataSource.query(`SELECT * FROM amenities`);
  }

  async getAllSalons() {
    const salons = await this.dataSource
      .getRepository('salons')
      .createQueryBuilder('salon')
      .where('salon.status = :status', { status: 'approved' })

      .leftJoinAndSelect('salon.services', 'salonService')
      .leftJoinAndSelect('salonService.service', 'service')

      .leftJoinAndSelect('salon.barbers', 'barber')

      .leftJoin('salon_amenities', 'sa', 'sa.salonId = salon.id')
      .leftJoin('amenities', 'amenity', 'amenity.id = sa.amenityId')

      .getRawAndEntities();

    const { entities, raw } = salons;

    return entities.map((salon, index) => ({
      id: salon.id,
      name: salon.name,
      address: salon.address,

      services: salon.services.map((s: any) => ({
        id: s.service.id,
        name: s.service.name,
        price: s.price,
        duration: s.duration,
      })),

      barbers: salon.barbers.map((b: any) => ({
        id: b.id,
        name: b.name,
        experience: b.experience,
      })),

      amenities: raw
        .filter((r) => r.salon_id === salon.id)
        .map((r) => ({
          id: r.amenity_id,
          name: r.amenity_name,
        })),
    }));
  }

  async approveSalon(id: string) {
    await this.dataSource.query(
      `UPDATE salons SET status = 'approved' WHERE id = $1`,
      [id],
    );

    return { message: 'Salon approved' };
  }
}
