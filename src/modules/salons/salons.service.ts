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
import { SalonAmenity } from './entities/salon-amenity.entity';
import { Service } from './entities/service.entity';
import { Amenity } from './entities/amenity.entity';
import { SalonFranchise } from './entities/salon-franchise.entity';
import { SalonFranchiseOwner } from './entities/salon-franchise-owner.entity';
import { Review } from './entities/review.entity';
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

    const [svcRows, amenityRows] = await Promise.all([
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
