import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'crypto';
import { DataSource } from 'typeorm';
import { User, UserRole } from '../users/user.entity';
import { Salon, SalonStatus } from './entities/salon.entity';
import { SalonService } from './entities/salon-service.entity';
import { Barber } from './entities/barber.entity';
import { SalonAmenity } from './entities/salon-amenity.entity';
import { Service } from './entities/service.entity';
import { Amenity } from './entities/amenity.entity';
import { SalonFranchise } from './entities/salon-franchise.entity';
import { SalonFranchiseOwner } from './entities/salon-franchise-owner.entity';
import { EmailQueueService } from '../auth/services/email-queue.service';
import { JWT_SECRET_FALLBACK } from '../auth/jwt.constants';

@Injectable()
export class SalonsService {
  constructor(
    private dataSource: DataSource,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailQueueService: EmailQueueService,
  ) {}

  // ─── Secret Code Helpers ────────────────────────────────────────────────────

  private generateSalonCode(salonName: string, phone: string): string {
    const nameDigits = salonName
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase()
      .slice(0, 3)
      .split('')
      .map((c) => (c.charCodeAt(0) % 10).toString())
      .join('')
      .padStart(3, '0');
    const random = Math.floor(1000 + Math.random() * 9000).toString();
    const phoneSuffix = phone.replace(/\D/g, '').slice(-3);
    return `${nameDigits}${random}${phoneSuffix}`;
  }

  private hashCode(code: string): string {
    const secret =
      this.configService.get<string>('OTP_HASH_SECRET') ??
      this.configService.get<string>('JWT_SECRET') ??
      JWT_SECRET_FALLBACK;
    return createHmac('sha256', secret).update(code).digest('hex');
  }

  private async uniqueSalonCode(salonName: string, phone: string): Promise<string> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const code = this.generateSalonCode(salonName, phone);
      const existing = await this.dataSource
        .getRepository(Salon)
        .findOne({ where: { secretCode: code } });
      if (!existing) return code;
    }
    throw new Error('Could not generate a unique salon code');
  }

  // ─── createSalon ────────────────────────────────────────────────────────────

  async createSalon(data: any) {
    // ── Identify login phone and owner details ──────────────────────────────
    // The SALON phone (contactNumber) is the login credential — each salon has
    // its own unique phone stored in User.phone.
    // The OWNER's phone goes only into SalonFranchiseOwner (records, not login).
    const salonPhone: string = (data.contactNumber ?? '').trim();
    const ownerName:  string = (data.ownerName     ?? '').trim();
    const ownerPhone: string = (data.ownerPhone    ?? '').trim();

    if (!/^\d{10}$/.test(salonPhone)) {
      throw new BadRequestException(
        'Please enter a valid 10-digit salon phone number.',
      );
    }

    if (!ownerName) {
      throw new BadRequestException('Owner name is required.');
    }

    // Uniqueness check on the SALON phone — not the owner phone.
    const existingUser = await this.dataSource
      .getRepository(User)
      .findOne({ where: { phone: salonPhone } });
    if (existingUser) {
      throw new BadRequestException(
        'This salon phone number is already registered. Please login.',
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Login User — phone = salon phone, fullName = owner name.
      //    Login is phone-based (OTP); email is NOT stored here because
      //    User.email has a unique constraint and the same owner email would
      //    conflict when the same owner registers a second salon.
      //    shopEmail is stored on the Salon entity and SalonFranchiseOwner only.
      const manager = queryRunner.manager.create(User, {
        phone:          salonPhone,
        fullName:       ownerName,
        role:           UserRole.PROFESSIONAL,
        hasAcceptedTerms: true,
        termsAcceptedAt:  new Date(),
      });
      const savedManager = await queryRunner.manager.save(manager);

      // 2. Business / Franchise owner record — reuse if ownerPhone already
      //    exists (same owner registering another salon), else create new.
      let savedFranchiseOwner: SalonFranchiseOwner;

      if (ownerPhone) {
        const existingOwner = await queryRunner.manager.findOne(
          SalonFranchiseOwner,
          { where: { phone: ownerPhone } },
        );
        if (existingOwner) {
          savedFranchiseOwner = existingOwner; // reuse — same owner, new salon
        } else {
          savedFranchiseOwner = await queryRunner.manager.save(
            queryRunner.manager.create(SalonFranchiseOwner, {
              name:  ownerName,
              phone: ownerPhone,
              email: data.shopEmail ?? null,
            }),
          );
        }
      } else {
        // No separate owner phone provided — create a minimal owner record
        savedFranchiseOwner = await queryRunner.manager.save(
          queryRunner.manager.create(SalonFranchiseOwner, {
            name:  ownerName,
            phone: salonPhone, // fallback: use salon phone as owner record
            email: data.shopEmail ?? null,
          }),
        );
      }

      // 3. Franchise — use existing if selected, otherwise auto-create.
      //    Every salon always gets a franchiseId regardless of the checkbox.
      let franchise: SalonFranchise;
      if (data.franchiseId) {
        const found = await queryRunner.manager.findOne(SalonFranchise, {
          where: { id: data.franchiseId },
        });
        if (!found) throw new BadRequestException('Franchise not found');
        franchise = found;
      } else {
        // Auto-create using salon name (or explicit franchiseName if provided)
        const franchiseName = (data.franchiseName as string | undefined)?.trim() || data.salonName;
        franchise = await queryRunner.manager.save(
          queryRunner.manager.create(SalonFranchise, { name: franchiseName }),
        );
      }

      // 4. Unique secret code — use salonPhone as seed (unique per salon)
      const secretCode = await this.uniqueSalonCode(data.salonName, salonPhone);

      // 5. Create salon
      const salon = queryRunner.manager.create(Salon, {
        name: data.salonName,
        address: data.address,
        city: data.city,
        state: data.state,
        pincode: data.pincode,
        landmark: data.landmark ?? null,
        email: data.shopEmail ?? null,
        contactNumber: data.contactNumber ?? null,
        manager: savedManager,
        franchiseOwner: savedFranchiseOwner,
        franchise,
        secretCode,
        secretCodeHash: this.hashCode(secretCode),
        openingTime: data.openingTime ?? null,
        closingTime: data.closingTime ?? null,
        workingDays: data.workingDays ?? null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
      });
      const savedSalon = await queryRunner.manager.save(salon);

      // 6. Services (name strings → look up by name)
      for (const serviceName of (data.services ?? []) as string[]) {
        const service = await queryRunner.manager.findOne(Service, {
          where: { name: serviceName },
        });
        if (!service) continue;
        await queryRunner.manager.save(
          queryRunner.manager.create(SalonService, { salon: savedSalon, service }),
        );
      }

      // 7. Amenities (name strings → look up by name)
      for (const amenityName of (data.amenities ?? []) as string[]) {
        const amenity = await queryRunner.manager.findOne(Amenity, {
          where: { name: amenityName },
        });
        if (!amenity) continue;
        await queryRunner.manager.save(
          queryRunner.manager.create(SalonAmenity, { salon: savedSalon, amenity }),
        );
      }

      // 8. Barbers
      for (const b of data.barbers ?? []) {
        await queryRunner.manager.save(
          queryRunner.manager.create(Barber, {
            salon: savedSalon,
            name: b.name,
            experience: parseInt(b.experience, 10) || 0,
          }),
        );
      }

      await queryRunner.commitTransaction();

      const access_token = this.jwtService.sign({
        sub: savedManager.id,
        phone: savedManager.phone,
      });

      return {
        message: 'Salon submitted successfully. Review will take up to 24 hours.',
        status: 'pending',
        salonId: savedSalon.id,
        createdAt: savedSalon.created_at.toISOString(),
        access_token,
        user: { id: savedManager.id, phone: savedManager.phone, role: savedManager.role },
      };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  // ─── verifySalonCode ────────────────────────────────────────────────────────

  async verifySalonCode(phone: string, code: string) {
    const user = await this.dataSource
      .getRepository(User)
      .findOne({ where: { phone } });
    if (!user) throw new UnauthorizedException('No account found for this phone');

    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: user.id }, status: SalonStatus.APPROVED },
    });
    if (!salon) throw new UnauthorizedException('No approved salon found for this account');

    if (this.hashCode(code) !== salon.secretCodeHash) {
      throw new UnauthorizedException('Invalid secret code');
    }

    return { valid: true };
  }

  // ─── getMySalons ────────────────────────────────────────────────────────────

  async getMySalons(userId: string) {
    const salons = await this.dataSource.getRepository(Salon).find({
      where: { manager: { id: userId } },
      relations: ['manager', 'franchiseOwner', 'franchise'],
      order: { created_at: 'DESC' },
    });

    return salons.map((s) => ({
      id: s.id,
      name: s.name,
      address: s.address,
      city: s.city,
      state: s.state,
      pincode: s.pincode,
      contactNumber: s.contactNumber,
      email: s.email,
      status: s.status,
      openingTime: s.openingTime,
      closingTime: s.closingTime,
      workingDays: s.workingDays,
      rating: s.rating ?? 0,
      reviewCount: s.reviewCount ?? 0,
      createdAt: s.created_at?.toISOString(),
      // Manager = the authenticated professional user
      manager: s.manager
        ? {
            id: s.manager.id,
            fullName: s.manager.fullName,
            phone: s.manager.phone,
            email: s.manager.email,
          }
        : null,
      // Franchise owner = business owner record (separate from auth user)
      franchiseOwner: s.franchiseOwner
        ? {
            id: s.franchiseOwner.id,
            name: s.franchiseOwner.name,
            phone: s.franchiseOwner.phone,
            email: s.franchiseOwner.email,
          }
        : null,
      franchise: s.franchise
        ? { id: s.franchise.id, name: s.franchise.name }
        : null,
    }));
  }

  // ─── searchFranchises ───────────────────────────────────────────────────────

  async searchFranchises(query: string) {
    return this.dataSource
      .getRepository(SalonFranchise)
      .createQueryBuilder('sf')
      .where('LOWER(sf.name) LIKE LOWER(:q)', { q: `%${query}%` })
      .orderBy('sf.name', 'ASC')
      .take(20)
      .getMany();
  }

  // ─── findNearby (kept for map-pin preview) ──────────────────────────────────

  async findNearby(lat: number, lng: number, radiusKm: number = 1) {
    return this.searchSalons({ lat, lng, radiusKm });
  }

  // ─── searchSalons ────────────────────────────────────────────────────────────
  // Full-featured search: Haversine distance, amenity/service filters, sort.
  // Distance answer (Q8): Haversine formula on (lat1,lng1) → (lat2,lng2) gives
  // the great-circle distance (straight line over Earth's surface, ~0.3% accurate
  // up to 100 km). PostgreSQL computes it with cos/sin/acos/radians builtins.

  async searchSalons(params: {
    lat: number;
    lng: number;
    radiusKm?: number;
    amenities?: string[];
    services?: string[];
    sort?: 'distance_asc' | 'distance_desc' | 'rating_desc' | 'reviews_desc' | 'relevance_desc';
  }) {
    const { lat, lng, radiusKm = 1, amenities = [], services = [], sort = 'distance_asc' } = params;

    // 1. Haversine — fetch all approved salons, compute distance
    const rows: any[] = await this.dataSource.query(
      `
      SELECT
        s.id, s.name, s.address, s.city, s.state, s.pincode,
        s."contactNumber", s."openingTime", s."closingTime", s."workingDays",
        s.latitude, s.longitude, s.rating, s."reviewCount",
        (6371 * acos(LEAST(1.0, GREATEST(-1.0,
          cos(radians($1)) * cos(radians(s.latitude))
            * cos(radians(s.longitude) - radians($2))
          + sin(radians($1)) * sin(radians(s.latitude))
        )))) AS distance
      FROM salons s
      WHERE s.status = 'approved'
        AND s.latitude  IS NOT NULL
        AND s.longitude IS NOT NULL
      ORDER BY distance ASC
      LIMIT 200
      `,
      [lat, lng],
    );

    // 2. Filter by radius
    let results = rows.filter((r) => Number(r.distance) <= radiusKm);

    if (results.length === 0) return [];

    const ids = results.map((r) => r.id as string);

    // 3. Batch-fetch services and amenities for matched salons
    const [svcRows, amenityRows] = await Promise.all([
      this.dataSource.query(
        `SELECT ss."salonId", svc.name
         FROM salon_services ss
         JOIN services svc ON svc.id = ss."serviceId"
         WHERE ss."salonId" = ANY($1)`,
        [ids],
      ),
      this.dataSource.query(
        `SELECT sa."salonId", a.name
         FROM salon_amenities sa
         JOIN amenities a ON a.id = sa."amenityId"
         WHERE sa."salonId" = ANY($1)`,
        [ids],
      ),
    ]);

    // Group by salonId
    const svcMap: Record<string, string[]> = {};
    for (const r of svcRows) {
      (svcMap[r.salonId] ??= []).push(r.name);
    }
    const amenityMap: Record<string, string[]> = {};
    for (const r of amenityRows) {
      (amenityMap[r.salonId] ??= []).push(r.name);
    }

    // 4. Attach services/amenities
    results = results.map((r) => ({
      ...r,
      services:  svcMap[r.id]     ?? [],
      amenities: amenityMap[r.id] ?? [],
    }));

    // 5. Apply filters (amenities: ALL must match; services: ANY must match)
    if (amenities.length > 0) {
      results = results.filter((r) =>
        amenities.every((a) => (r.amenities as string[]).includes(a)),
      );
    }
    if (services.length > 0) {
      results = results.filter((r) =>
        services.some((s) => (r.services as string[]).includes(s)),
      );
    }

    // 6. Sort
    results.sort((a, b) => {
      switch (sort) {
        case 'distance_asc':   return Number(a.distance)  - Number(b.distance);
        case 'distance_desc':  return Number(b.distance)  - Number(a.distance);
        case 'rating_desc':    return Number(b.rating)    - Number(a.rating);
        case 'reviews_desc':   return Number(b.reviewCount) - Number(a.reviewCount);
        case 'relevance_desc': {
          // Bayesian-weighted: rating × ln(1 + reviewCount)
          const scoreA = Number(a.rating) * Math.log(1 + Number(a.reviewCount));
          const scoreB = Number(b.rating) * Math.log(1 + Number(b.reviewCount));
          return scoreB - scoreA;
        }
        default: return Number(a.distance) - Number(b.distance);
      }
    });

    return results.map((r) => ({
      id:           r.id,
      name:         r.name,
      address:      r.address,
      city:         r.city,
      state:        r.state,
      pincode:      r.pincode,
      contactNumber: r.contactNumber,
      openingTime:  r.openingTime,
      closingTime:  r.closingTime,
      workingDays:  r.workingDays,
      latitude:     parseFloat(r.latitude),
      longitude:    parseFloat(r.longitude),
      rating:       parseFloat(r.rating)      || 0,
      reviewCount:  parseInt(r.reviewCount)   || 0,
      distance:     Math.round(Number(r.distance) * 100) / 100,
      services:     r.services  as string[],
      amenities:    r.amenities as string[],
    }));
  }

  // ─── approveSalon ───────────────────────────────────────────────────────────

  async approveSalon(id: string) {
    await this.dataSource.query(
      `UPDATE salons SET status = 'approved' WHERE id = $1`,
      [id],
    );

    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { id },
      relations: ['manager'],
    });

    if (salon?.manager?.email && salon.secretCode) {
      try {
        await this.emailQueueService.sendApprovalEmail(salon.manager.email, {
          ownerName: salon.manager.fullName ?? 'Salon Manager',
          salonName: salon.name,
          address: salon.address,
          city: salon.city,
          state: salon.state,
          phone: salon.manager.phone,
          secretCode: salon.secretCode,
        });
      } catch {
        // Email failure must not fail the approval
      }
    }

    return { message: 'Salon approved' };
  }

  // ─── Catalog helpers ────────────────────────────────────────────────────────

  async seedServices() {
    const services = ['Haircut', 'Beard Trim', 'Hair Color', 'Facial', 'Shave', 'Head Massage'];
    for (const name of services) {
      await this.dataSource.query(
        `INSERT INTO services (id, name) VALUES (gen_random_uuid(), $1) ON CONFLICT (name) DO NOTHING`,
        [name],
      );
    }
    return { message: 'Services seeded' };
  }

  async getServices() {
    return this.dataSource.query(`SELECT * FROM services`);
  }

  async seedAmenities() {
    const amenities = ['AC', 'Parking', 'WiFi', 'TV', 'Card Payment', 'Waiting Area'];
    for (const name of amenities) {
      await this.dataSource.query(
        `INSERT INTO amenities (id, name) VALUES (gen_random_uuid(), $1) ON CONFLICT (name) DO NOTHING`,
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

    return entities.map((salon) => ({
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
        .map((r) => ({ id: r.amenity_id, name: r.amenity_name })),
    }));
  }
}
