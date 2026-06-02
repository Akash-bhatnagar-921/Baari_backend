import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'crypto';
import { DataSource } from 'typeorm';
import { User, UserRole } from '../users/user.entity';
import { Salon, SalonStatus } from './entities/salon.entity';
import { SalonService } from './entities/salon-service.entity';
import { Barber } from './entities/barber.entity';
import { BarberFollow } from './entities/barber-follow.entity';
import { SalonPortfolio } from './entities/salon-portfolio.entity';
import { SalonAmenity } from './entities/salon-amenity.entity';
import { Service } from './entities/service.entity';
import { Amenity } from './entities/amenity.entity';
import { SalonFranchise } from './entities/salon-franchise.entity';
import { SalonFranchiseOwner } from './entities/salon-franchise-owner.entity';
import { Review } from './entities/review.entity';
import { WalkIn } from './entities/walk-in.entity';
import { InventoryItem } from './entities/inventory-item.entity';
import { BarberAttendance } from './entities/barber-attendance.entity';
import { EmailQueueService } from '../auth/services/email-queue.service';
import { PushNotificationService } from '../users/push-notification.service';
import { JWT_SECRET_FALLBACK } from '../auth/jwt.constants';

@Injectable()
export class SalonsService {
  constructor(
    private dataSource: DataSource,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailQueueService: EmailQueueService,
    private push: PushNotificationService,
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

  private async uniqueSalonCode(
    salonName: string,
    phone: string,
  ): Promise<string> {
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
    const ownerName: string = (data.ownerName ?? '').trim();
    const ownerPhone: string = (data.ownerPhone ?? '').trim();

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

    // Auto-geocode address before transaction (external call — must not block on failure)
    let geoLat = salonPhone ? (data.latitude ?? null) : null;
    let geoLng = salonPhone ? (data.longitude ?? null) : null;
    if (!geoLat || !geoLng) {
      const coords = await this.geocodeAddress(
        data.address,
        data.city,
        data.state,
      );
      if (coords) {
        geoLat = coords.lat;
        geoLng = coords.lng;
      }
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
        phone: salonPhone,
        fullName: ownerName,
        role: UserRole.PROFESSIONAL,
        hasAcceptedTerms: true,
        termsAcceptedAt: new Date(),
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
              name: ownerName,
              phone: ownerPhone,
              email: data.shopEmail ?? null,
            }),
          );
        }
      } else {
        // No separate owner phone provided — create a minimal owner record
        savedFranchiseOwner = await queryRunner.manager.save(
          queryRunner.manager.create(SalonFranchiseOwner, {
            name: ownerName,
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
        const franchiseName =
          (data.franchiseName as string | undefined)?.trim() || data.salonName;
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
        latitude: geoLat,
        longitude: geoLng,
      });
      const savedSalon = await queryRunner.manager.save(salon);

      // 6. Services (name strings → look up by name)
      for (const serviceName of (data.services ?? []) as string[]) {
        const service = await queryRunner.manager.findOne(Service, {
          where: { name: serviceName },
        });
        if (!service) continue;
        await queryRunner.manager.save(
          queryRunner.manager.create(SalonService, {
            salon: savedSalon,
            service,
          }),
        );
      }

      // 7. Amenities (name strings → look up by name)
      for (const amenityName of (data.amenities ?? []) as string[]) {
        const amenity = await queryRunner.manager.findOne(Amenity, {
          where: { name: amenityName },
        });
        if (!amenity) continue;
        await queryRunner.manager.save(
          queryRunner.manager.create(SalonAmenity, {
            salon: savedSalon,
            amenity,
          }),
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
        role: savedManager.role,
      });

      return {
        message:
          'Salon submitted successfully. Review will take up to 24 hours.',
        status: 'pending',
        salonId: savedSalon.id,
        createdAt: savedSalon.created_at.toISOString(),
        access_token,
        user: {
          id: savedManager.id,
          phone: savedManager.phone,
          role: savedManager.role,
        },
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
    if (!user)
      throw new UnauthorizedException('No account found for this phone');

    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: user.id }, status: SalonStatus.APPROVED },
    });
    if (!salon)
      throw new UnauthorizedException(
        'No approved salon found for this account',
      );

    if (this.hashCode(code) !== salon.secretCodeHash) {
      throw new UnauthorizedException('Invalid secret code');
    }

    return { valid: true };
  }

  // ─── getMySalons ────────────────────────────────────────────────────────────

  async getMySalons(userId: string) {
    const salons = await this.dataSource.getRepository(Salon).find({
      where: { manager: { id: userId } },
      relations: [
        'manager',
        'franchiseOwner',
        'franchise',
        'services',
        'services.service',
        'barbers',
      ],
      order: { created_at: 'DESC' },
    });

    for (const s of salons) {
      // ── Promote admin-approved pending location to live fields ──────────────
      if (s.hasPendingLocation && s.locationApproved) {
        const updates: Partial<Salon> = {
          hasPendingLocation: false,
          locationApproved: false,
          pendingLatitude:  undefined as any,
          pendingLongitude: undefined as any,
          pendingAddress:   undefined as any,
          pendingCity:      undefined as any,
          pendingState:     undefined as any,
          pendingPincode:   undefined as any,
        };

        if (s.pendingLatitude)  updates.latitude  = s.pendingLatitude;
        if (s.pendingLongitude) updates.longitude = s.pendingLongitude;
        if (s.pendingAddress)   updates.address   = s.pendingAddress;
        if (s.pendingCity)      updates.city      = s.pendingCity;
        if (s.pendingState)     updates.state     = s.pendingState;
        if (s.pendingPincode)   updates.pincode   = s.pendingPincode;

        await this.dataSource.getRepository(Salon).update(s.id, updates);

        // Mirror into the in-memory object so the response is already correct
        if (s.pendingLatitude)  s.latitude  = s.pendingLatitude;
        if (s.pendingLongitude) s.longitude = s.pendingLongitude;
        if (s.pendingAddress)   s.address   = s.pendingAddress;
        if (s.pendingCity)      s.city      = s.pendingCity;
        if (s.pendingState)     s.state     = s.pendingState;
        if (s.pendingPincode)   s.pincode   = s.pendingPincode;
        s.hasPendingLocation = false;
        s.locationApproved   = false;
      }

      // ── Auto-geocode any salon that is still missing coordinates ────────────
      if (!s.latitude || !s.longitude) {
        const coords = await this.geocodeAddress(s.address, s.city, s.state);
        if (coords) {
          await this.dataSource
            .getRepository(Salon)
            .update(s.id, { latitude: coords.lat, longitude: coords.lng });
          s.latitude = coords.lat;
          s.longitude = coords.lng;
        }
      }
    }

    // Batch-fetch amenities for all salons
    const ids = salons.map((s) => s.id);
    const amenityRows: any[] = ids.length
      ? await this.dataSource.query(
          `SELECT sa."salonId", a.id AS "amenityId", a.name AS "amenityName"
           FROM salon_amenities sa
           JOIN amenities a ON a.id = sa."amenityId"
           WHERE sa."salonId" = ANY($1)`,
          [ids],
        )
      : [];

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
      services: (s.services ?? [])
        .filter((ss) => ss.service)
        .map((ss) => ({
          id: ss.service.id,
          name: ss.service.name,
          price: ss.price,
          duration: ss.duration,
        })),
      amenities: amenityRows
        .filter((r) => r.salonId === s.id)
        .map((r) => r.amenityName),
      barbers: (s.barbers ?? []).map((b) => ({
        id: b.id,
        name: b.name,
        experience: b.experience,
      })),
      isServicesConfigured: (s.services ?? []).some(
        (ss) => ss.price != null && ss.price > 0,
      ),
      isOpen: s.isOpen ?? true,
      hasPendingLocation: s.hasPendingLocation ?? false,
      locationApproved: s.locationApproved ?? false,
      pendingAddress: s.pendingAddress ?? null,
      pendingCity:    s.pendingCity    ?? null,
      pendingState:   s.pendingState   ?? null,
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
    sort?:
      | 'distance_asc'
      | 'distance_desc'
      | 'rating_desc'
      | 'reviews_desc'
      | 'relevance_desc';
  }) {
    const {
      lat,
      lng,
      radiusKm = 1,
      amenities = [],
      services = [],
      sort = 'distance_asc',
    } = params;

    // 1. Haversine — fetch approved, open salons that have at least one priced service
    const rows: any[] = await this.dataSource.query(
      `
      SELECT
        s.id, s.name, s.address, s.city, s.state, s.pincode,
        s."contactNumber", s."openingTime", s."closingTime", s."workingDays",
        s.latitude, s.longitude, s.rating, s."reviewCount", s.image,
        s.featured, s."priorityListing",
        (6371 * acos(LEAST(1.0, GREATEST(-1.0,
          cos(radians($1)) * cos(radians(s.latitude))
            * cos(radians(s.longitude) - radians($2))
          + sin(radians($1)) * sin(radians(s.latitude))
        )))) AS distance
      FROM salons s
      WHERE s.status   = 'approved'
        AND s."isOpen" = true
        AND s.latitude  IS NOT NULL
        AND s.longitude IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM salon_services ss
          WHERE ss."salonId" = s.id
            AND ss.price IS NOT NULL
            AND ss.price > 0
        )
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
      // Only include services that have a price — unpriced services are hidden from customers
      this.dataSource.query(
        `SELECT ss."salonId", svc.name
         FROM salon_services ss
         JOIN services svc ON svc.id = ss."serviceId"
         WHERE ss."salonId" = ANY($1)
           AND ss.price IS NOT NULL AND ss.price > 0`,
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
      services: svcMap[r.id] ?? [],
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

    // 6. Sort — featured salons always first, then priority-listed, then user's chosen order
    results.sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      if (a.priorityListing !== b.priorityListing) return a.priorityListing ? -1 : 1;
      switch (sort) {
        case 'distance_asc':
          return Number(a.distance) - Number(b.distance);
        case 'distance_desc':
          return Number(b.distance) - Number(a.distance);
        case 'rating_desc':
          return Number(b.rating) - Number(a.rating);
        case 'reviews_desc':
          return Number(b.reviewCount) - Number(a.reviewCount);
        case 'relevance_desc': {
          // Bayesian-weighted: rating × ln(1 + reviewCount)
          const scoreA = Number(a.rating) * Math.log(1 + Number(a.reviewCount));
          const scoreB = Number(b.rating) * Math.log(1 + Number(b.reviewCount));
          return scoreB - scoreA;
        }
        default:
          return Number(a.distance) - Number(b.distance);
      }
    });

    return results.map((r) => ({
      id: r.id,
      name: r.name,
      address: r.address,
      city: r.city,
      state: r.state,
      pincode: r.pincode,
      contactNumber: r.contactNumber,
      openingTime: r.openingTime,
      closingTime: r.closingTime,
      workingDays: r.workingDays,
      latitude: parseFloat(r.latitude),
      longitude: parseFloat(r.longitude),
      rating: parseFloat(r.rating) || 0,
      reviewCount: parseInt(r.reviewCount) || 0,
      distance: Math.round(Number(r.distance) * 100) / 100,
      featured: r.featured === true,
      priorityListing: r.priorityListing === true,
      services: r.services as string[],
      amenities: r.amenities as string[],
    }));
  }

  // ─── Auto-geocoding ─────────────────────────────────────────────────────────

  private geocodeAddress(
    address: string,
    city: string,
    state: string,
  ): Promise<{ lat: number; lng: number } | null> {
    // Uses Node's built-in https — no extra package needed.
    return new Promise((resolve) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const https = require('https') as typeof import('https');
        const q = encodeURIComponent(`${address}, ${city}, ${state}, India`);
        const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;

        const req = https.get(
          url,
          { headers: { 'User-Agent': 'Baari/1.0 (salon-booking-app)' } },
          (res) => {
            let raw = '';
            res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
            res.on('end', () => {
              try {
                const results = JSON.parse(raw) as Array<{
                  lat: string;
                  lon: string;
                }>;
                if (results.length > 0) {
                  resolve({
                    lat: parseFloat(results[0].lat),
                    lng: parseFloat(results[0].lon),
                  });
                } else {
                  resolve(null);
                }
              } catch {
                resolve(null);
              }
            });
          },
        );
        req.on('error', () => resolve(null));
        req.setTimeout(6000, () => {
          req.destroy();
          resolve(null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // ─── getMySalonConfig ───────────────────────────────────────────────────────
  // Returns all predefined services/amenities with enabled flags and prices.

  async getMySalonConfig(userId: string) {
    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: userId } },
      relations: ['services', 'services.service'],
    });
    if (!salon)
      throw new UnauthorizedException('No salon found for this account');

    const [allServices, allAmenities, salonAmenities] = await Promise.all([
      this.dataSource.getRepository(Service).find({ order: { name: 'ASC' } }),
      this.dataSource.getRepository(Amenity).find({ order: { name: 'ASC' } }),
      this.dataSource.query(
        `SELECT a.id, a.name FROM salon_amenities sa
         JOIN amenities a ON a.id = sa."amenityId"
         WHERE sa."salonId" = $1`,
        [salon.id],
      ),
    ]);

    const enabledAmenityIds = new Set<string>(
      salonAmenities.map((a: any) => a.id),
    );
    const salonServiceMap = new Map(
      salon.services
        .filter((ss) => ss.service)
        .map((ss) => [
          ss.service.id,
          { price: ss.price, duration: ss.duration, ssId: ss.id },
        ]),
    );

    return {
      salonId: salon.id,
      isServicesConfigured: salon.services.some(
        (ss) => ss.price != null && ss.price > 0,
      ),
      services: allServices.map((svc) => ({
        id: svc.id,
        name: svc.name,
        enabled: salonServiceMap.has(svc.id),
        price: salonServiceMap.get(svc.id)?.price ?? null,
        duration: salonServiceMap.get(svc.id)?.duration ?? null,
      })),
      amenities: allAmenities.map((a) => ({
        id: a.id,
        name: a.name,
        enabled: enabledAmenityIds.has(a.id),
      })),
    };
  }

  // ─── updateMySalonServices ──────────────────────────────────────────────────

  async updateMySalonServices(
    userId: string,
    services: Array<{
      serviceId?: string;
      serviceName: string;
      price: number;
      duration?: number;
    }>,
  ) {
    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: userId } },
    });
    if (!salon) throw new UnauthorizedException('No salon found');

    // Replace all service entries for this salon
    await this.dataSource
      .getRepository(SalonService)
      .delete({ salon: { id: salon.id } as any });

    for (const s of services) {
      let svc: Service | null = null;

      // Try lookup by UUID first (predefined services)
      const isRealUuid = s.serviceId && /^[0-9a-f-]{36}$/i.test(s.serviceId);
      if (isRealUuid) {
        svc = await this.dataSource
          .getRepository(Service)
          .findOne({ where: { id: s.serviceId } });
      }

      // Fallback: find or create by name (handles custom services)
      if (!svc && s.serviceName?.trim()) {
        const name = s.serviceName.trim();
        svc = await this.dataSource
          .getRepository(Service)
          .findOne({ where: { name } });
        if (!svc) {
          svc = await this.dataSource
            .getRepository(Service)
            .save(this.dataSource.getRepository(Service).create({ name }));
        }
      }

      if (!svc) continue;

      await this.dataSource.getRepository(SalonService).save(
        this.dataSource.getRepository(SalonService).create({
          salon,
          service: svc,
          price: s.price,
          duration: s.duration ?? undefined,
        }),
      );
    }
    return { message: 'Services updated successfully' };
  }

  // ─── updateMySalonAmenities ─────────────────────────────────────────────────

  async updateMySalonAmenities(
    userId: string,
    amenities: Array<{ amenityId?: string; amenityName: string }>,
  ) {
    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: userId } },
    });
    if (!salon) throw new UnauthorizedException('No salon found');

    await this.dataSource.query(
      `DELETE FROM salon_amenities WHERE "salonId" = $1`,
      [salon.id],
    );

    for (const a of amenities) {
      let amenity: Amenity | null = null;

      const isRealUuid = a.amenityId && /^[0-9a-f-]{36}$/i.test(a.amenityId);
      if (isRealUuid) {
        amenity = await this.dataSource
          .getRepository(Amenity)
          .findOne({ where: { id: a.amenityId } });
      }

      if (!amenity && a.amenityName?.trim()) {
        const name = a.amenityName.trim();
        amenity = await this.dataSource
          .getRepository(Amenity)
          .findOne({ where: { name } });
        if (!amenity) {
          amenity = await this.dataSource
            .getRepository(Amenity)
            .save(this.dataSource.getRepository(Amenity).create({ name }));
        }
      }

      if (!amenity) continue;
      await this.dataSource
        .getRepository(SalonAmenity)
        .save(
          this.dataSource
            .getRepository(SalonAmenity)
            .create({ salon, amenity }),
        );
    }
    return { message: 'Amenities updated successfully' };
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

    if (!salon) return { message: 'Salon approved' };

    // Geocode on approval so the salon appears in map searches immediately
    if (!salon.latitude || !salon.longitude) {
      const coords = await this.geocodeAddress(
        salon.address,
        salon.city,
        salon.state,
      );
      if (coords) {
        await this.dataSource
          .getRepository(Salon)
          .update(id, { latitude: coords.lat, longitude: coords.lng });
      }
    }

    if (salon.manager?.email && salon.secretCode) {
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

    // Push notification to the professional
    if (salon.manager?.id) {
      setImmediate(() =>
        this.push.sendToUser(
          salon.manager.id,
          'Salon Approved! 🎉',
          `${salon.name} is now live on Baari. Customers can start booking appointments.`,
          { salonId: salon.id, type: 'salon_approved' },
        ).catch(() => {}),
      );
    }

    return { message: 'Salon approved' };
  }

  // ─── Professional: toggle salon open/closed ────────────────────────────────

  async toggleSalonOpen(userId: string, isOpen: boolean) {
    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: userId } },
    });
    if (!salon) throw new UnauthorizedException('No salon found');

    await this.dataSource.getRepository(Salon).update(salon.id, { isOpen });
    return {
      message: isOpen ? 'Salon is now Open' : 'Salon is now Closed',
      isOpen,
    };
  }

  // ─── Professional: upload/replace salon cover photo ─────────────────────────

  async updateSalonPhoto(userId: string, imagePath: string) {
    const repo = this.dataSource.getRepository(Salon);
    const salon = await repo.findOne({ where: { manager: { id: userId } } });
    if (!salon) throw new UnauthorizedException('No salon found');
    await repo.update(salon.id, { image: imagePath });
    return { message: 'Photo updated', image: imagePath };
  }

  // ─── Professional: request a location update (requires admin approval) ────────

  async updateMyLocation(
    userId: string,
    lat: number,
    lng: number,
    address: string,
  ) {
    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: userId } },
    });
    if (!salon)
      throw new UnauthorizedException('No salon found for this account');

    await this.dataSource.getRepository(Salon).update(salon.id, {
      pendingLatitude: lat,
      pendingLongitude: lng,
      pendingAddress: address,
      hasPendingLocation: true,
    });

    return {
      message:
        'Location update submitted. It will go live after Baari admin approval.',
      hasPendingLocation: true,
      pendingAddress: address,
    };
  }

  // ─── Professional: update text address (city/state/pincode) — requires approval ─

  async updateSalonAddress(
    userId: string,
    data: { city: string; state: string; pincode?: string; address?: string },
  ) {
    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: userId } },
    });
    if (!salon) throw new UnauthorizedException('No salon found for this account');

    const pendingCityVal  = data.city.trim();
    const pendingStateVal = data.state.trim();

    await this.dataSource.getRepository(Salon).update(salon.id, {
      pendingCity:          pendingCityVal,
      pendingState:         pendingStateVal,
      pendingPincode:       data.pincode?.trim() ?? (null as any),
      pendingAddress:       data.address?.trim()  ?? salon.address,
      hasPendingLocation:   true,
      locationApproved:     false,
    });

    return {
      message: 'Address update submitted. It will go live after admin approval.',
      hasPendingLocation: true,
      pendingCity:  pendingCityVal,
      pendingState: pendingStateVal,
    };
  }

  // ─── Admin: retroactively geocode all approved salons with missing coords ────

  async syncMissingGeocodesAdmin() {
    const salons = await this.dataSource.query(
      `SELECT id, address, city, state FROM salons
       WHERE status = 'approved'
         AND (latitude IS NULL OR longitude IS NULL)`,
    );

    let fixed = 0;
    for (const s of salons as Array<{
      id: string;
      address: string;
      city: string;
      state: string;
    }>) {
      const coords = await this.geocodeAddress(s.address, s.city, s.state);
      if (coords) {
        await this.dataSource.query(
          `UPDATE salons SET latitude = $1, longitude = $2 WHERE id = $3`,
          [coords.lat, coords.lng, s.id],
        );
        fixed++;
      }
    }
    return {
      total: salons.length,
      fixed,
      message: `${fixed}/${salons.length} salons geocoded`,
    };
  }

  // ─── Catalog helpers ────────────────────────────────────────────────────────

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
        `INSERT INTO amenities (id, name) VALUES (gen_random_uuid(), $1) ON CONFLICT (name) DO NOTHING`,
        [name],
      );
    }
    return { message: 'Amenities seeded' };
  }

  async getAmenities() {
    return this.dataSource.query(`SELECT * FROM amenities`);
  }

  // ─── getSalonById (customer-facing detail) ─────────────────────────────────

  async getSalonById(salonId: string) {
    const rows = await this.dataSource.query(
      `SELECT s.id, s.name, s.address, s.city, s.state, s.pincode,
              s."openingTime", s."closingTime", s."workingDays",
              s."contactNumber", s.latitude, s.longitude,
              s.rating, s."reviewCount", s.image,
              (SELECT COUNT(*) FROM barbers b WHERE b."salonId" = s.id)::int AS "barberCount"
       FROM salons s
       WHERE s.id = $1::uuid AND s.status = 'approved'`,
      [salonId],
    );
    if (!rows.length) return null;

    const salon = rows[0];

    const [svcRows, amenityRows, barberRows] = await Promise.all([
      this.dataSource.query(
        `SELECT ss.id AS "salonServiceId", svc.id AS "serviceId", svc.name AS "serviceName",
                ss.price, ss.duration
         FROM salon_services ss
         JOIN services svc ON svc.id = ss."serviceId"
         WHERE ss."salonId" = $1 AND ss.price IS NOT NULL AND ss.price > 0
         ORDER BY svc.name ASC`,
        [salonId],
      ),
      this.dataSource.query(
        `SELECT a.name FROM salon_amenities sa
         JOIN amenities a ON a.id = sa."amenityId"
         WHERE sa."salonId" = $1 ORDER BY a.name ASC`,
        [salonId],
      ),
      this.dataSource.query(
        `SELECT id, name, specialization, "photoUrl", experience, "isAvailable",
                "leaveUntil", "breakUntil", "workingDays", "followersCount"
         FROM barbers WHERE "salonId" = $1 ORDER BY name ASC`,
        [salonId],
      ),
    ]);

    return {
      id: salon.id,
      name: salon.name,
      address: salon.address,
      city: salon.city,
      state: salon.state,
      pincode: salon.pincode,
      openingTime: salon.openingTime,
      closingTime: salon.closingTime,
      workingDays: salon.workingDays,
      contactNumber: salon.contactNumber,
      latitude: salon.latitude ? parseFloat(salon.latitude) : null,
      longitude: salon.longitude ? parseFloat(salon.longitude) : null,
      rating: parseFloat(salon.rating) || 0,
      reviewCount: parseInt(salon.reviewCount) || 0,
      image: salon.image ?? null,
      barberCount: salon.barberCount,
      barbers: barberRows.map((b: any) => ({
        id: b.id,
        name: b.name,
        specialization: b.specialization ?? null,
        photoUrl: b.photoUrl ?? null,
        experience: b.experience ?? 0,
        isAvailable: b.isAvailable,
        leaveUntil: b.leaveUntil ?? null,
        breakUntil: b.breakUntil ?? null,
        workingDays: b.workingDays ?? null,
        followersCount: b.followersCount ?? 0,
      })),
      services: svcRows.map((r: any) => ({
        id: r.serviceId,
        serviceName: r.serviceName,
        price: parseFloat(r.price),
        duration: r.duration ? parseInt(r.duration) : 30,
      })),
      amenities: amenityRows.map((r: any) => r.name as string),
    };
  }

  // ─── getMyReviews (professional) ─────────────────────────────────────────────

  async getMyReviews(userId: string) {
    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: userId } },
    });
    if (!salon)
      throw new UnauthorizedException('No salon found for this account');
    return this.getSalonReviews(salon.id);
  }

  // ─── getSalonReviews ──────────────────────────────────────────────────────────

  async getSalonReviews(salonId: string) {
    const rows = await this.dataSource.query(
      `SELECT r.rating, r.comment, r."createdAt",
              u."fullName" AS "reviewerName"
       FROM reviews r
       LEFT JOIN users u ON u.id = r."userId"::uuid
       WHERE r."salonId" = $1
       ORDER BY r."createdAt" DESC
       LIMIT 50`,
      [salonId],
    );
    return rows.map((r: any) => ({
      rating: r.rating,
      comment: r.comment ?? '',
      reviewerName: r.reviewerName ?? 'Customer',
      createdAt: r.createdAt,
    }));
  }

  // ─── My Barbers CRUD (professional) ───────────────────────────────────────────

  async getMyBarbers(userId: string) {
    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: userId } },
    });
    if (!salon) throw new UnauthorizedException('No salon found');
    return this.dataSource.getRepository(Barber).find({
      where: { salon: { id: salon.id } },
      order: { name: 'ASC' },
    });
  }

  async addBarber(
    userId: string,
    name: string,
    experience: number,
    workingDays?: string,
  ) {
    if (!name?.trim())
      throw new BadRequestException('Barber name is required.');
    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: userId } },
    });
    if (!salon) throw new UnauthorizedException('No salon found');

    const maxBarbers = await this.getMaxBarbers(userId);
    const barberCount = await this.dataSource.getRepository(Barber).count({
      where: { salon: { id: salon.id } },
    });
    if (barberCount >= maxBarbers) {
      const planLabel = await this.getPlanLabel(userId);
      const limit = maxBarbers === Infinity ? 'unlimited' : String(maxBarbers);
      throw new BadRequestException(
        `BARBER_LIMIT: Your ${planLabel} plan allows up to ${limit} barber${maxBarbers === 1 ? '' : 's'}. Upgrade to add more.`,
      );
    }

    const barber = this.dataSource.getRepository(Barber).create({
      salon,
      name: name.trim(),
      experience: experience ?? 0,
      workingDays: workingDays ?? (null as any),
    });
    return this.dataSource.getRepository(Barber).save(barber);
  }

  private async getMaxBarbers(userId: string): Promise<number> {
    const rows = await this.dataSource.query(
      `SELECT plan, status, "expiresAt" FROM subscriptions WHERE "userId" = $1`,
      [userId],
    );
    const sub = rows[0];
    if (!sub || sub.status === 'cancelled') return 1;
    if (sub.expiresAt && new Date() > new Date(sub.expiresAt)) return 1;
    const limits: Record<string, number> = {
      professional_starter: 3,
      professional_growth: 10,
      professional_premium: Infinity,
    };
    return limits[sub.plan] ?? 1;
  }

  private async getPlanLabel(userId: string): Promise<string> {
    const rows = await this.dataSource.query(
      `SELECT plan, status, "expiresAt" FROM subscriptions WHERE "userId" = $1`,
      [userId],
    );
    const sub = rows[0];
    if (!sub || sub.status === 'cancelled') return 'Free';
    if (sub.expiresAt && new Date() > new Date(sub.expiresAt)) return 'Free';
    const labels: Record<string, string> = {
      professional_starter: 'Starter',
      professional_growth: 'Growth',
      professional_premium: 'Premium',
    };
    return labels[sub.plan] ?? 'Free';
  }

  async updateBarber(
    userId: string,
    barberId: string,
    data: { name?: string; experience?: number; workingDays?: string | null },
  ) {
    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: userId } },
    });
    if (!salon) throw new UnauthorizedException('No salon found');
    const barber = await this.dataSource.getRepository(Barber).findOne({
      where: { id: barberId, salon: { id: salon.id } },
    });
    if (!barber) throw new NotFoundException('Barber not found.');
    if (data.name !== undefined) barber.name = data.name.trim();
    if (data.experience !== undefined) barber.experience = data.experience;
    if ('workingDays' in data) barber.workingDays = data.workingDays as any;
    return this.dataSource.getRepository(Barber).save(barber);
  }

  async deleteBarber(userId: string, barberId: string) {
    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: userId } },
    });
    if (!salon) throw new UnauthorizedException('No salon found');
    const barber = await this.dataSource.getRepository(Barber).findOne({
      where: { id: barberId, salon: { id: salon.id } },
    });
    if (!barber) throw new NotFoundException('Barber not found.');
    await this.dataSource.getRepository(Barber).remove(barber);
    return { message: 'Barber removed successfully' };
  }

  // ─── Update working hours/days (professional) ───────────────────────────────

  async updateWorkingHours(
    userId: string,
    openingTime: string,
    closingTime: string,
    workingDays: string,
  ) {
    const salon = await this.dataSource.getRepository(Salon).findOne({
      where: { manager: { id: userId } },
    });
    if (!salon) throw new UnauthorizedException('No salon found');
    await this.dataSource.getRepository(Salon).update(salon.id, {
      openingTime: openingTime ?? salon.openingTime,
      closingTime: closingTime ?? salon.closingTime,
      workingDays: workingDays ?? salon.workingDays,
    });
    return {
      message: 'Working hours updated successfully',
      openingTime,
      closingTime,
      workingDays,
    };
  }

  // ─── Rating recalculation helper ─────────────────────────────────────────────
  // Recomputes rating + reviewCount from live review rows and writes back to the
  // salon row.  Call after any review insert, update, or delete so the
  // denormalised columns never drift.

  private async _recalculateSalonRating(
    salonId: string,
  ): Promise<{ avgRating: number; reviewCount: number }> {
    const agg = await this.dataSource.query(
      `SELECT ROUND(AVG(rating)::numeric, 1) AS avg, COUNT(*) AS cnt
       FROM reviews WHERE "salonId" = $1`,
      [salonId],
    );
    const avgRating   = parseFloat(agg[0]?.avg ?? '0');
    const reviewCount = parseInt(agg[0]?.cnt ?? '0', 10);
    await this.dataSource.query(
      `UPDATE salons SET rating = $1, "reviewCount" = $2 WHERE id = $3::uuid`,
      [avgRating, reviewCount, salonId],
    );
    return { avgRating, reviewCount };
  }

  // ─── submitReview ────────────────────────────────────────────────────────────

  async submitReview(
    userId: string,
    salonId: string,
    bookingId: string | null,
    rating: number,
    comment: string,
  ) {
    if (rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be between 1 and 5.');
    }

    // User must have a completed (or confirmed) booking at this salon
    const hasBooking = await this.dataSource.query(
      `SELECT 1 FROM bookings
       WHERE "userId" = $1 AND "salonId" = $2 AND status IN ('confirmed','completed')
       LIMIT 1`,
      [userId, salonId],
    );
    if (!hasBooking.length) {
      throw new BadRequestException(
        'You can only review salons you have booked.',
      );
    }

    // Upsert: update if already reviewed, else insert
    const repo = this.dataSource.getRepository(Review);
    const existing = await repo.findOne({ where: { userId, salonId } });
    if (existing) {
      await repo.update(existing.id, {
        rating,
        comment: comment?.trim() || existing.comment,
        bookingId: bookingId ?? existing.bookingId,
      });
    } else {
      await repo.save(
        repo.create({
          userId,
          salonId,
          bookingId: bookingId ?? '',
          rating,
          comment: comment?.trim() ?? '',
        }),
      );
    }

    const { reviewCount } = await this._recalculateSalonRating(salonId);
    return { message: 'Review submitted successfully', rating, reviewCount };
  }

  // ── Trending Salons (most booked this week; by location or city) ─────────────

  async getTrendingSalons(city?: string): Promise<{ topSalons: any[]; popularServices: any[] }>;
  async getTrendingSalons(lat: number, lng: number, radiusKm?: number): Promise<{ topSalons: any[]; popularServices: any[] }>;
  async getTrendingSalons(
    latOrCity?: number | string,
    lng?: number,
    radiusKm = 10,
  ): Promise<{ topSalons: any[]; popularServices: any[] }> {
    const useGeo = typeof latOrCity === 'number' && lng !== undefined;
    const city   = typeof latOrCity === 'string' ? latOrCity.trim() : undefined;

    const [topSalons, popularServices] = await Promise.all([
      useGeo
        ? this.dataSource.query(
            `SELECT s.id, s.name, s.address, s.city, s.image, s.rating, s."reviewCount",
                    s.featured, s."priorityListing",
                    COUNT(b.id)::int AS "weeklyBookings",
                    ROUND(CAST(6371 * acos(LEAST(1.0, GREATEST(-1.0,
                      cos(radians($1)) * cos(radians(s.latitude)) *
                      cos(radians(s.longitude) - radians($2)) +
                      sin(radians($1)) * sin(radians(s.latitude))
                    ))) AS numeric), 2) AS distance
             FROM salons s
             LEFT JOIN bookings b ON b."salonId" = s.id::text
               AND b.status NOT IN ('cancelled', 'rejected', 'expired')
               AND b."createdAt" >= NOW() - INTERVAL '7 days'
             WHERE s.status = 'approved' AND s."isOpen" = true
               AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
             GROUP BY s.id
             HAVING (6371 * acos(LEAST(1.0, GREATEST(-1.0,
               cos(radians($1)) * cos(radians(s.latitude)) *
               cos(radians(s.longitude) - radians($2)) +
               sin(radians($1)) * sin(radians(s.latitude))
             ))) <= $3
             ORDER BY "weeklyBookings" DESC, s.rating DESC
             LIMIT 10`,
            [latOrCity, lng, radiusKm],
          )
        : this.dataSource.query(
            `SELECT s.id, s.name, s.address, s.city, s.image, s.rating, s."reviewCount",
                    s.featured, s."priorityListing",
                    COUNT(b.id)::int AS "weeklyBookings"
             FROM salons s
             LEFT JOIN bookings b ON b."salonId" = s.id::text
               AND b.status NOT IN ('cancelled', 'rejected', 'expired')
               AND b."createdAt" >= NOW() - INTERVAL '7 days'
             WHERE s.status = 'approved' AND s."isOpen" = true
               ${city ? `AND s.city ILIKE $1` : ''}
             GROUP BY s.id
             ORDER BY "weeklyBookings" DESC, s.rating DESC
             LIMIT 10`,
            city ? [`%${city}%`] : [],
          ),
      this.dataSource.query(
        `SELECT svc->>'serviceName' AS service, COUNT(*)::int AS count
         FROM bookings, jsonb_array_elements(services) AS svc
         WHERE status IN ('completed', 'in_progress')
           AND "createdAt" >= NOW() - INTERVAL '30 days'
           ${city ? `AND "salonId" IN (SELECT id FROM salons WHERE city ILIKE $1)` : ''}
         GROUP BY 1
         ORDER BY 2 DESC
         LIMIT 8`,
        city ? [`%${city}%`] : [],
      ),
    ]);

    return {
      topSalons: topSalons.map((r: any) => ({
        id: r.id,
        name: r.name,
        address: r.address,
        city: r.city,
        image: r.image ?? null,
        rating: parseFloat(r.rating ?? '0'),
        reviewCount: parseInt(r.reviewCount ?? '0'),
        featured: r.featured,
        priorityListing: r.priorityListing,
        weeklyBookings: r.weeklyBookings ?? 0,
        distance: r.distance ? parseFloat(r.distance) : undefined,
      })),
      popularServices: popularServices.map((r: any) => ({
        service: r.service,
        count: r.count ?? 0,
      })),
    };
  }

  // ── Salon Queue (live occupancy for a salon) ─────────────────────────────────

  async getSalonQueue(salonId: string) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [queueRows, barberRows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*) AS cnt, COALESCE(AVG("totalDuration"), 30)::int AS avg_duration
         FROM bookings
         WHERE "salonId" = $1
           AND status IN ('confirmed', 'in_progress')
           AND "scheduledAt" >= $2
           AND "scheduledAt" <= NOW() + INTERVAL '3 hours'`,
        [salonId, todayStart.toISOString()],
      ),
      this.dataSource.query(
        `SELECT COALESCE(COUNT(*), 1)::int AS cnt FROM barbers WHERE "salonId" = $1`,
        [salonId],
      ),
    ]);

    const queueSize = parseInt(queueRows[0]?.cnt ?? '0');
    const avgDuration = parseInt(queueRows[0]?.avg_duration ?? '30');
    const barberCount = Math.max(1, parseInt(barberRows[0]?.cnt ?? '1'));

    return {
      queueSize,
      barberCount,
      estimatedWaitMins: Math.round((queueSize / barberCount) * avgDuration),
      isAvailable: queueSize < barberCount,
    };
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

  // ─── Barber profile (public) ─────────────────────────────────────────────────

  async getBarberProfile(barberId: string) {
    const rows = await this.dataSource.query(
      `SELECT b.id, b.name, b.experience, b.specialization, b.bio, b."photoUrl",
              b.gallery, b."isAvailable", b."leaveUntil", b."breakUntil",
              b."openingTime", b."closingTime", b."workingDays", b."followersCount",
              s.id AS "salonId", s.name AS "salonName", s.city,
              COALESCE(AVG(r.rating)::float, 0) AS rating,
              COUNT(DISTINCT bk.id)::int AS "completedBookings"
       FROM barbers b
       JOIN salons s ON s.id = b."salonId"::uuid
       LEFT JOIN reviews r ON r."salonId" = s.id::text
       LEFT JOIN bookings bk ON bk."salonId" = s.id::text AND bk.status = 'completed'
       WHERE b.id = $1::uuid
       GROUP BY b.id, s.id`,
      [barberId],
    );
    if (!rows.length) throw new NotFoundException('Barber not found');
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      experience: r.experience ?? 0,
      specialization: r.specialization ?? null,
      bio: r.bio ?? null,
      photoUrl: r.photoUrl ?? null,
      gallery: r.gallery ?? [],
      isAvailable: r.isAvailable,
      leaveUntil: r.leaveUntil ?? null,
      breakUntil: r.breakUntil ?? null,
      openingTime: r.openingTime ?? null,
      closingTime: r.closingTime ?? null,
      workingDays: r.workingDays ?? null,
      followersCount: r.followersCount ?? 0,
      salonId: r.salonId,
      salonName: r.salonName,
      city: r.city,
      rating: parseFloat(r.rating) || 0,
      completedBookings: r.completedBookings ?? 0,
    };
  }

  // ─── Update barber profile details (professional) ────────────────────────────

  async updateBarberProfile(
    userId: string,
    barberId: string,
    data: {
      specialization?: string;
      bio?: string;
      openingTime?: string;
      closingTime?: string;
    },
  ) {
    const salon = await this.dataSource
      .getRepository(Salon)
      .findOne({ where: { manager: { id: userId } } });
    if (!salon) throw new UnauthorizedException('No salon found');
    const barber = await this.dataSource
      .getRepository(Barber)
      .findOne({ where: { id: barberId, salon: { id: salon.id } } });
    if (!barber) throw new NotFoundException('Barber not found');
    if (data.specialization !== undefined) barber.specialization = data.specialization;
    if (data.bio !== undefined) barber.bio = data.bio;
    if (data.openingTime !== undefined) barber.openingTime = data.openingTime;
    if (data.closingTime !== undefined) barber.closingTime = data.closingTime;
    return this.dataSource.getRepository(Barber).save(barber);
  }

  // ─── Upload barber profile photo (professional) ──────────────────────────────

  async uploadBarberPhoto(userId: string, barberId: string, imagePath: string) {
    const salon = await this.dataSource
      .getRepository(Salon)
      .findOne({ where: { manager: { id: userId } } });
    if (!salon) throw new UnauthorizedException('No salon found');
    const barber = await this.dataSource
      .getRepository(Barber)
      .findOne({ where: { id: barberId, salon: { id: salon.id } } });
    if (!barber) throw new NotFoundException('Barber not found');
    barber.photoUrl = imagePath;
    await this.dataSource.getRepository(Barber).save(barber);
    return { message: 'Photo updated', photoUrl: imagePath };
  }

  // ─── Barber gallery management (professional) ────────────────────────────────

  async addToBarberGallery(
    userId: string,
    barberId: string,
    imagePath: string,
    caption?: string,
  ) {
    const salon = await this.dataSource
      .getRepository(Salon)
      .findOne({ where: { manager: { id: userId } } });
    if (!salon) throw new UnauthorizedException('No salon found');
    const barber = await this.dataSource
      .getRepository(Barber)
      .findOne({ where: { id: barberId, salon: { id: salon.id } } });
    if (!barber) throw new NotFoundException('Barber not found');
    const gallery = barber.gallery ?? [];
    gallery.push({ url: imagePath, ...(caption ? { caption } : {}) });
    barber.gallery = gallery;
    await this.dataSource.getRepository(Barber).save(barber);
    return { message: 'Photo added', gallery: barber.gallery };
  }

  async removeFromBarberGallery(
    userId: string,
    barberId: string,
    index: number,
  ) {
    const salon = await this.dataSource
      .getRepository(Salon)
      .findOne({ where: { manager: { id: userId } } });
    if (!salon) throw new UnauthorizedException('No salon found');
    const barber = await this.dataSource
      .getRepository(Barber)
      .findOne({ where: { id: barberId, salon: { id: salon.id } } });
    if (!barber) throw new NotFoundException('Barber not found');
    const gallery = barber.gallery ?? [];
    if (index < 0 || index >= gallery.length)
      throw new BadRequestException('Invalid gallery index');
    gallery.splice(index, 1);
    barber.gallery = gallery;
    await this.dataSource.getRepository(Barber).save(barber);
    return { message: 'Photo removed', gallery: barber.gallery };
  }

  // ─── Barber availability / leave / break (professional) ──────────────────────

  async setBarberAvailability(
    userId: string,
    barberId: string,
    data: {
      isAvailable: boolean;
      leaveUntil?: string | null;
      breakUntil?: string | null;
    },
  ) {
    const salon = await this.dataSource
      .getRepository(Salon)
      .findOne({ where: { manager: { id: userId } } });
    if (!salon) throw new UnauthorizedException('No salon found');
    const barber = await this.dataSource
      .getRepository(Barber)
      .findOne({ where: { id: barberId, salon: { id: salon.id } } });
    if (!barber) throw new NotFoundException('Barber not found');
    barber.isAvailable = data.isAvailable;
    barber.leaveUntil = data.leaveUntil ? new Date(data.leaveUntil) : (null as any);
    barber.breakUntil = data.breakUntil ? new Date(data.breakUntil) : (null as any);
    await this.dataSource.getRepository(Barber).save(barber);
    return { message: 'Availability updated', isAvailable: barber.isAvailable };
  }

  // ─── Follow / Unfollow barber (customer) ─────────────────────────────────────

  async followBarber(userId: string, barberId: string) {
    const barber = await this.dataSource
      .getRepository(Barber)
      .findOne({ where: { id: barberId } });
    if (!barber) throw new NotFoundException('Barber not found');
    const existing = await this.dataSource
      .getRepository(BarberFollow)
      .findOne({ where: { userId, barberId } });
    if (existing) return { message: 'Already following', followersCount: barber.followersCount };
    await this.dataSource.getRepository(BarberFollow).save({ userId, barberId });
    await this.dataSource.getRepository(Barber).increment({ id: barberId }, 'followersCount', 1);
    return { message: 'Following', followersCount: (barber.followersCount ?? 0) + 1 };
  }

  async unfollowBarber(userId: string, barberId: string) {
    const existing = await this.dataSource
      .getRepository(BarberFollow)
      .findOne({ where: { userId, barberId } });
    if (!existing) return { message: 'Not following' };
    await this.dataSource.getRepository(BarberFollow).remove(existing);
    await this.dataSource.getRepository(Barber).decrement({ id: barberId }, 'followersCount', 1);
    return { message: 'Unfollowed' };
  }

  async getFollowedBarbers(userId: string) {
    const rows = await this.dataSource.query(
      `SELECT b.id, b.name, b.specialization, b."photoUrl", b.experience,
              b."followersCount", b."isAvailable",
              s.name AS "salonName", s.id AS "salonId", s.city
       FROM barber_follows bf
       JOIN barbers b ON b.id = bf."barberId"::uuid
       JOIN salons s ON s.id = b."salonId"::uuid
       WHERE bf."userId" = $1
       ORDER BY bf."createdAt" DESC`,
      [userId],
    );
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      specialization: r.specialization ?? null,
      photoUrl: r.photoUrl ?? null,
      experience: r.experience ?? 0,
      followersCount: r.followersCount ?? 0,
      isAvailable: r.isAvailable,
      salonId: r.salonId,
      salonName: r.salonName,
      city: r.city,
    }));
  }

  async isFollowingBarber(userId: string, barberId: string): Promise<boolean> {
    const count = await this.dataSource
      .getRepository(BarberFollow)
      .count({ where: { userId, barberId } });
    return count > 0;
  }

  // ─── Salon portfolio — before/after & work photos ───────────────────────────

  async getSalonPortfolio(salonId: string) {
    const rows = await this.dataSource.query(
      `SELECT id, "salonId", type, "photoUrl", "beforeUrl", caption, "createdAt"
       FROM salon_portfolio
       WHERE "salonId" = $1
       ORDER BY "createdAt" DESC
       LIMIT 50`,
      [salonId],
    );
    return rows;
  }

  async addSalonPortfolio(
    userId: string,
    data: {
      type?: string;
      photoUrl: string;
      beforeUrl?: string;
      caption?: string;
    },
  ) {
    const salon = await this.dataSource
      .getRepository(Salon)
      .findOne({ where: { manager: { id: userId } } });
    if (!salon) throw new UnauthorizedException('No salon found');
    await this.dataSource
      .getRepository(SalonPortfolio)
      .save({
        salonId: salon.id,
        type: data.type ?? 'portfolio',
        photoUrl: data.photoUrl,
        beforeUrl: data.beforeUrl ?? (null as any),
        caption: data.caption ?? (null as any),
      });
    return { message: 'Portfolio photo added' };
  }

  async deleteSalonPortfolio(userId: string, photoId: string) {
    const salon = await this.dataSource
      .getRepository(Salon)
      .findOne({ where: { manager: { id: userId } } });
    if (!salon) throw new UnauthorizedException('No salon found');
    const item = await this.dataSource
      .getRepository(SalonPortfolio)
      .findOne({ where: { id: photoId, salonId: salon.id } });
    if (!item) throw new NotFoundException('Portfolio item not found');
    await this.dataSource.getRepository(SalonPortfolio).remove(item);
    return { message: 'Deleted', id: photoId };
  }

  // ─── Walk-in queue ───────────────────────────────────────────────────────────

  private async salonForUser(userId: string): Promise<Salon> {
    const salon = await this.dataSource
      .getRepository(Salon)
      .findOne({ where: { manager: { id: userId } } });
    if (!salon) throw new UnauthorizedException('No salon found');
    return salon;
  }

  async addWalkIn(
    userId: string,
    data: {
      customerName: string;
      customerPhone?: string;
      barberId?: string;
      services?: Array<{
        serviceId?: string;
        serviceName: string;
        price: number;
        duration: number;
      }>;
      notes?: string;
      /** ISO timestamp — when set, blocks the slot in the availability grid */
      scheduledAt?: string;
    },
  ) {
    const salon = await this.salonForUser(userId);

    // Block the salon's own contact number from being used as a customer phone
    if (
      data.customerPhone &&
      salon.contactNumber &&
      data.customerPhone.trim() === salon.contactNumber.trim()
    ) {
      throw new BadRequestException(
        "You can't create a booking under your own salon's phone number",
      );
    }

    const services = data.services ?? [];
    const totalAmount = services.reduce((s, i) => s + (i.price ?? 0), 0);
    const totalDuration = services.reduce((s, i) => s + (i.duration ?? 0), 0);
    const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
    return this.dataSource.getRepository(WalkIn).save({
      salonId: salon.id,
      customerName: data.customerName,
      customerPhone: data.customerPhone ?? (null as any),
      barberId: data.barberId ?? (null as any),
      services,
      totalAmount,
      totalDuration,
      // Scheduled offline bookings are immediately confirmed; walk-ins wait to be called
      status: scheduledAt ? 'confirmed' : 'waiting',
      notes: data.notes ?? (null as any),
      scheduledAt: scheduledAt as any,
    });
  }

  async getWalkIns(userId: string, date?: string) {
    const salon = await this.salonForUser(userId);
    const d = date ?? new Date().toISOString().slice(0, 10);
    return this.dataSource.query(
      `SELECT w.*, b.name AS "barberName"
       FROM walk_ins w
       LEFT JOIN barbers b ON b.id = w."barberId"::uuid
       WHERE w."salonId" = $1
         AND DATE(w."createdAt" AT TIME ZONE 'UTC') = $2
       ORDER BY w."createdAt" DESC`,
      [salon.id, d],
    );
  }

  async updateWalkIn(
    userId: string,
    walkInId: string,
    data: { status?: string; barberId?: string; notes?: string },
  ) {
    const salon = await this.salonForUser(userId);
    const row = await this.dataSource
      .getRepository(WalkIn)
      .findOne({ where: { id: walkInId, salonId: salon.id } });
    if (!row) throw new NotFoundException('Walk-in not found');
    if (data.status !== undefined) row.status = data.status;
    if (data.barberId !== undefined) row.barberId = data.barberId as any;
    if (data.notes !== undefined) row.notes = data.notes as any;
    await this.dataSource.getRepository(WalkIn).save(row);
    return { message: 'Updated', id: walkInId };
  }

  async deleteWalkIn(userId: string, walkInId: string) {
    const salon = await this.salonForUser(userId);
    const row = await this.dataSource
      .getRepository(WalkIn)
      .findOne({ where: { id: walkInId, salonId: salon.id } });
    if (!row) throw new NotFoundException('Walk-in not found');
    await this.dataSource.getRepository(WalkIn).remove(row);
    return { message: 'Deleted', id: walkInId };
  }

  // ─── Schedule gaps (appointment optimisation) ────────────────────────────────

  async getScheduleGaps(userId: string, date?: string) {
    const salon = await this.salonForUser(userId);
    const d = date ?? new Date().toISOString().slice(0, 10);

    const [bookings, walkIns] = await Promise.all([
      this.dataSource.query(
        `SELECT "scheduledAt", "totalDuration"
         FROM bookings
         WHERE "salonId" = $1
           AND DATE("scheduledAt") = $2
           AND status IN ('pending','confirmed','in_progress')
         ORDER BY "scheduledAt" ASC`,
        [salon.id, d],
      ),
      this.dataSource.query(
        `SELECT "createdAt" AS "scheduledAt", "totalDuration"
         FROM walk_ins
         WHERE "salonId" = $1
           AND DATE("createdAt" AT TIME ZONE 'UTC') = $2
           AND status IN ('waiting','in_progress')
         ORDER BY "createdAt" ASC`,
        [salon.id, d],
      ),
    ]);

    const openH = salon.openingTime ?? '09:00';
    const closeH = salon.closingTime ?? '21:00';
    const openMs = new Date(`${d}T${openH}:00Z`).getTime();
    const closeMs = new Date(`${d}T${closeH}:00Z`).getTime();
    const totalMinutes = (closeMs - openMs) / 60000;

    const slots: Array<{ scheduledAt: Date; totalDuration: number }> = [
      ...bookings,
      ...walkIns,
    ]
      .map((s: any) => ({
        scheduledAt: new Date(s.scheduledAt),
        totalDuration: parseInt(s.totalDuration, 10) || 0,
      }))
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());

    const gaps: Array<{
      from: string;
      to: string;
      durationMinutes: number;
    }> = [];
    let cursor = openMs;

    for (const s of slots) {
      const start = s.scheduledAt.getTime();
      const end = start + s.totalDuration * 60000;
      const gapMin = (start - cursor) / 60000;
      if (gapMin >= 15) {
        gaps.push({
          from: new Date(cursor).toISOString(),
          to: new Date(start).toISOString(),
          durationMinutes: Math.round(gapMin),
        });
      }
      if (end > cursor) cursor = end;
    }

    const tailMin = (closeMs - cursor) / 60000;
    if (tailMin >= 15) {
      gaps.push({
        from: new Date(cursor).toISOString(),
        to: new Date(closeMs).toISOString(),
        durationMinutes: Math.round(tailMin),
      });
    }

    const bookedMinutes = totalMinutes - gaps.reduce((s, g) => s + g.durationMinutes, 0);
    const utilization = totalMinutes > 0 ? Math.round((bookedMinutes / totalMinutes) * 100) : 0;

    return {
      date: d,
      openingTime: openH,
      closingTime: closeH,
      totalMinutes,
      bookedMinutes,
      utilizationRate: utilization,
      gaps,
      totalBookings: bookings.length,
      totalWalkIns: walkIns.length,
    };
  }

  // ─── Inventory management ────────────────────────────────────────────────────

  async getInventory(userId: string) {
    const salon = await this.salonForUser(userId);
    return this.dataSource.query(
      `SELECT * FROM inventory_items
       WHERE "salonId" = $1
       ORDER BY category NULLS LAST, name ASC`,
      [salon.id],
    );
  }

  async addInventoryItem(
    userId: string,
    data: {
      name: string;
      category?: string;
      quantity?: number;
      unit?: string;
      minStock?: number;
      costPerUnit?: number;
      notes?: string;
    },
  ) {
    const salon = await this.salonForUser(userId);
    return this.dataSource.getRepository(InventoryItem).save({
      salonId: salon.id,
      name: data.name,
      category: data.category ?? (null as any),
      quantity: data.quantity ?? 0,
      unit: data.unit ?? 'units',
      minStock: data.minStock ?? 0,
      costPerUnit: data.costPerUnit ?? (null as any),
      notes: data.notes ?? (null as any),
    });
  }

  async updateInventoryItem(
    userId: string,
    itemId: string,
    data: Partial<{
      name: string;
      category: string;
      quantity: number;
      unit: string;
      minStock: number;
      costPerUnit: number;
      notes: string;
    }>,
  ) {
    const salon = await this.salonForUser(userId);
    const item = await this.dataSource
      .getRepository(InventoryItem)
      .findOne({ where: { id: itemId, salonId: salon.id } });
    if (!item) throw new NotFoundException('Inventory item not found');
    Object.assign(item, data);
    return this.dataSource.getRepository(InventoryItem).save(item);
  }

  async deleteInventoryItem(userId: string, itemId: string) {
    const salon = await this.salonForUser(userId);
    const item = await this.dataSource
      .getRepository(InventoryItem)
      .findOne({ where: { id: itemId, salonId: salon.id } });
    if (!item) throw new NotFoundException('Inventory item not found');
    await this.dataSource.getRepository(InventoryItem).remove(item);
    return { message: 'Deleted', id: itemId };
  }

  // ─── Attendance ──────────────────────────────────────────────────────────────

  async getAttendance(userId: string, month: number, year: number) {
    const salon = await this.salonForUser(userId);
    return this.dataSource.query(
      `SELECT a.*, b.name AS "barberName"
       FROM barber_attendance a
       JOIN barbers b ON b.id = a."barberId"::uuid
       WHERE a."salonId" = $1
         AND EXTRACT(MONTH FROM a.date::date) = $2
         AND EXTRACT(YEAR  FROM a.date::date) = $3
       ORDER BY a.date DESC, b.name ASC`,
      [salon.id, month, year],
    );
  }

  async markAttendance(
    userId: string,
    data: {
      barberId: string;
      date: string;
      clockIn?: string;
      clockOut?: string;
      status: string;
      notes?: string;
    },
  ) {
    const salon = await this.salonForUser(userId);
    await this.dataSource.query(
      `INSERT INTO barber_attendance
         ("barberId", "salonId", date, "clockIn", "clockOut", status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ("barberId", date) DO UPDATE
         SET "clockIn"  = EXCLUDED."clockIn",
             "clockOut" = EXCLUDED."clockOut",
             status     = EXCLUDED.status,
             notes      = EXCLUDED.notes`,
      [
        data.barberId,
        salon.id,
        data.date,
        data.clockIn ?? null,
        data.clockOut ?? null,
        data.status,
        data.notes ?? null,
      ],
    );
    return { message: 'Attendance recorded' };
  }

  // ─── Payroll summary ─────────────────────────────────────────────────────────

  async getPayrollSummary(userId: string, month: number, year: number) {
    const salon = await this.salonForUser(userId);

    const barbers: any[] = await this.dataSource.query(
      `SELECT id, name, "baseSalary", "commissionRate", "salaryType"
       FROM barbers WHERE "salonId" = $1 ORDER BY name ASC`,
      [salon.id],
    );

    return Promise.all(
      barbers.map(async (barber) => {
        const [walkInStats, attendanceStats] = await Promise.all([
          this.dataSource.query(
            `SELECT COALESCE(SUM("totalAmount"), 0) AS revenue,
                    COUNT(*) AS bookings
             FROM walk_ins
             WHERE "barberId" = $1
               AND "salonId" = $2
               AND status = 'completed'
               AND EXTRACT(MONTH FROM "createdAt") = $3
               AND EXTRACT(YEAR  FROM "createdAt") = $4`,
            [barber.id, salon.id, month, year],
          ),
          this.dataSource.query(
            `SELECT
               COUNT(*) FILTER (WHERE status = 'present')  AS present,
               COUNT(*) FILTER (WHERE status = 'absent')   AS absent,
               COUNT(*) FILTER (WHERE status = 'leave')    AS leave,
               COUNT(*) FILTER (WHERE status = 'half_day') AS half_day
             FROM barber_attendance
             WHERE "barberId" = $1
               AND "salonId" = $2
               AND EXTRACT(MONTH FROM date::date) = $3
               AND EXTRACT(YEAR  FROM date::date) = $4`,
            [barber.id, salon.id, month, year],
          ),
        ]);

        const revenue = parseFloat(walkInStats[0].revenue ?? '0');
        const commissionRate = parseFloat(barber.commissionRate ?? '0');
        const baseSalary = parseFloat(barber.baseSalary ?? '0');
        const commissionEarned = revenue * (commissionRate / 100);
        const totalPay =
          barber.salaryType === 'commission'
            ? commissionEarned
            : barber.salaryType === 'hybrid'
              ? baseSalary + commissionEarned
              : baseSalary;

        return {
          barberId: barber.id,
          barberName: barber.name,
          salaryType: barber.salaryType ?? 'fixed',
          baseSalary,
          commissionRate,
          revenue,
          totalWalkIns: parseInt(walkInStats[0].bookings ?? '0', 10),
          commissionEarned,
          totalPay,
          attendance: {
            present: parseInt(attendanceStats[0].present ?? '0', 10),
            absent: parseInt(attendanceStats[0].absent ?? '0', 10),
            leave: parseInt(attendanceStats[0].leave ?? '0', 10),
            halfDay: parseInt(attendanceStats[0].half_day ?? '0', 10),
          },
        };
      }),
    );
  }

  async updateBarberPayrollSettings(
    userId: string,
    barberId: string,
    data: { baseSalary?: number; commissionRate?: number; salaryType?: string },
  ) {
    const salon = await this.salonForUser(userId);
    const barber = await this.dataSource
      .getRepository(Barber)
      .findOne({ where: { id: barberId, salon: { id: salon.id } } });
    if (!barber) throw new NotFoundException('Barber not found');
    if (data.baseSalary !== undefined) barber.baseSalary = data.baseSalary as any;
    if (data.commissionRate !== undefined) barber.commissionRate = data.commissionRate as any;
    if (data.salaryType !== undefined) barber.salaryType = data.salaryType;
    await this.dataSource.getRepository(Barber).save(barber);
    return {
      message: 'Payroll settings updated',
      barberId,
      baseSalary: barber.baseSalary,
      commissionRate: barber.commissionRate,
      salaryType: barber.salaryType,
    };
  }

  // ─── Advanced analytics ──────────────────────────────────────────────────────

  async getSalonAnalytics(userId: string, period: string = '30d') {
    const salon = await this.salonForUser(userId);
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const interval = `${days} days`;

    const [
      overviewRows,
      peakHours,
      revenueTrend,
      topServices,
      cancellationReasons,
      customerRows,
      walkInRows,
      barberPerformanceRows,
    ] = await Promise.all([
      this.dataSource.query(
        `SELECT
           COUNT(*)                                         AS total_bookings,
           COALESCE(SUM("totalAmount"), 0)                 AS total_revenue,
           COUNT(*) FILTER (WHERE status = 'completed')    AS completed,
           COUNT(*) FILTER (WHERE status = 'cancelled')    AS cancelled,
           COUNT(*) FILTER (WHERE status = 'rejected')     AS rejected
         FROM bookings
         WHERE "salonId" = $1
           AND "createdAt" >= NOW() - INTERVAL '${interval}'`,
        [salon.id],
      ),
      this.dataSource.query(
        `SELECT EXTRACT(HOUR FROM "scheduledAt") AS hour, COUNT(*) AS bookings
         FROM bookings
         WHERE "salonId" = $1
           AND status IN ('completed','in_progress','confirmed')
           AND "createdAt" >= NOW() - INTERVAL '${interval}'
         GROUP BY 1 ORDER BY 1`,
        [salon.id],
      ),
      this.dataSource.query(
        `SELECT DATE("scheduledAt") AS date,
                COALESCE(SUM("totalAmount"), 0) AS revenue,
                COUNT(*) AS bookings
         FROM bookings
         WHERE "salonId" = $1
           AND status = 'completed'
           AND "createdAt" >= NOW() - INTERVAL '${interval}'
         GROUP BY 1 ORDER BY 1`,
        [salon.id],
      ),
      this.dataSource.query(
        `SELECT s->>'serviceName' AS service, COUNT(*) AS bookings
         FROM bookings,
              jsonb_array_elements(services) AS s
         WHERE "salonId" = $1
           AND status = 'completed'
           AND "createdAt" >= NOW() - INTERVAL '${interval}'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
        [salon.id],
      ),
      this.dataSource.query(
        `SELECT COALESCE("cancellationReason", 'No reason given') AS reason,
                COUNT(*) AS count
         FROM bookings
         WHERE "salonId" = $1
           AND status = 'cancelled'
           AND "createdAt" >= NOW() - INTERVAL '${interval}'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
        [salon.id],
      ),
      this.dataSource.query(
        `SELECT
           COUNT(DISTINCT "userId")                                          AS unique_customers,
           COUNT(DISTINCT "userId") FILTER (WHERE booking_count > 1)        AS repeat_customers
         FROM (
           SELECT "userId", COUNT(*) AS booking_count
           FROM bookings
           WHERE "salonId" = $1 AND status = 'completed'
           GROUP BY "userId"
         ) sub`,
        [salon.id],
      ),
      this.dataSource.query(
        `SELECT
           COUNT(*)                                         AS total,
           COUNT(*) FILTER (WHERE status = 'completed')    AS completed,
           COALESCE(SUM("totalAmount") FILTER (WHERE status = 'completed'), 0) AS revenue
         FROM walk_ins
         WHERE "salonId" = $1
           AND "createdAt" >= NOW() - INTERVAL '${interval}'`,
        [salon.id],
      ),
      this.dataSource.query(
        `SELECT b.id, b.name AS barber_name,
                COUNT(w.id)                                           AS total,
                COUNT(w.id) FILTER (WHERE w.status = 'completed')    AS completed,
                COALESCE(SUM(w."totalAmount") FILTER (WHERE w.status = 'completed'), 0) AS revenue
         FROM barbers b
         LEFT JOIN walk_ins w
           ON w."barberId" = b.id::text
          AND w."createdAt" >= NOW() - INTERVAL '${interval}'
         WHERE b."salonId" = $1
         GROUP BY b.id, b.name
         ORDER BY completed DESC, total DESC`,
        [salon.id],
      ),
    ]);

    const ov = overviewRows[0];
    const cu = customerRows[0];
    const wi = walkInRows[0];

    const uniqueCustomers = parseInt(cu.unique_customers ?? '0', 10);
    const repeatCustomers = parseInt(cu.repeat_customers ?? '0', 10);
    const repeatRate = uniqueCustomers > 0
      ? Math.round((repeatCustomers / uniqueCustomers) * 100)
      : 0;

    return {
      period,
      overview: {
        totalBookings: parseInt(ov.total_bookings ?? '0', 10),
        totalRevenue: parseFloat(ov.total_revenue ?? '0'),
        completed: parseInt(ov.completed ?? '0', 10),
        cancelled: parseInt(ov.cancelled ?? '0', 10),
        rejected: parseInt(ov.rejected ?? '0', 10),
      },
      customerRetention: {
        uniqueCustomers,
        repeatCustomers,
        repeatRate,
      },
      peakHours: peakHours.map((r: any) => ({
        hour: parseInt(r.hour, 10),
        bookings: parseInt(r.bookings, 10),
      })),
      revenueTrend: revenueTrend.map((r: any) => ({
        date: r.date,
        revenue: parseFloat(r.revenue),
        bookings: parseInt(r.bookings, 10),
      })),
      topServices: topServices.map((r: any) => ({
        service: r.service,
        bookings: parseInt(r.bookings, 10),
      })),
      cancellationReasons: cancellationReasons.map((r: any) => ({
        reason: r.reason,
        count: parseInt(r.count, 10),
      })),
      barberPerformance: barberPerformanceRows.map((r: any) => ({
        id: r.id,
        name: r.barber_name,
        total: parseInt(r.total ?? '0', 10),
        completed: parseInt(r.completed ?? '0', 10),
        revenue: parseFloat(r.revenue ?? '0'),
      })),
      walkIns: {
        total: parseInt(wi.total ?? '0', 10),
        completed: parseInt(wi.completed ?? '0', 10),
        revenue: parseFloat(wi.revenue ?? '0'),
      },
    };
  }
}
