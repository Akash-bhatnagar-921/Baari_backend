import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Offer } from './entities/offer.entity';

@Injectable()
export class OffersService {
  constructor(private readonly dataSource: DataSource) {}

  private get repo() {
    return this.dataSource.getRepository(Offer);
  }

  // ── Professional: resolve salonId for the logged-in manager ─────────────────

  private async _salon(managerId: string): Promise<{ id: string; name: string }> {
    const rows = await this.dataSource.query(
      `SELECT id, name FROM salons WHERE "managerId" = $1::uuid LIMIT 1`,
      [managerId],
    );
    if (!rows.length) throw new UnauthorizedException('No salon found for this account.');
    return rows[0] as { id: string; name: string };
  }

  // ── Professional CRUD ────────────────────────────────────────────────────────

  async createOffer(
    managerId: string,
    body: { title: string; description?: string; discountPercent?: number; validUntil?: string },
  ) {
    const salon = await this._salon(managerId);
    const offer = this.repo.create({
      salonId:         salon.id,
      salonName:       salon.name,
      title:           body.title,
      description:     body.description ?? '',
      discountPercent: body.discountPercent ?? 0,
      validUntil:      body.validUntil ? new Date(body.validUntil) : undefined,
      isActive:        true,
    });
    return this.repo.save(offer);
  }

  async getMyOffers(managerId: string) {
    const salon = await this._salon(managerId);
    return this.repo.find({
      where: { salonId: salon.id },
      order: { createdAt: 'DESC' },
    });
  }

  async updateOffer(
    offerId: string,
    managerId: string,
    body: { title?: string; description?: string; discountPercent?: number; validUntil?: string; isActive?: boolean },
  ) {
    const salon = await this._salon(managerId);
    const offer = await this.repo.findOne({ where: { id: offerId, salonId: salon.id } });
    if (!offer) throw new NotFoundException('Offer not found.');
    if (body.title           !== undefined) offer.title           = body.title;
    if (body.description     !== undefined) offer.description     = body.description;
    if (body.discountPercent !== undefined) offer.discountPercent = body.discountPercent;
    if (body.validUntil      !== undefined) offer.validUntil      = new Date(body.validUntil);
    if (body.isActive        !== undefined) offer.isActive        = body.isActive;
    return this.repo.save(offer);
  }

  async deleteOffer(offerId: string, managerId: string) {
    const salon = await this._salon(managerId);
    const offer = await this.repo.findOne({ where: { id: offerId, salonId: salon.id } });
    if (!offer) throw new NotFoundException('Offer not found.');
    await this.repo.remove(offer);
    return { deleted: true };
  }

  // ── Customer: read active offers ─────────────────────────────────────────────

  async getOffersBySalon(salonId: string) {
    const now = new Date();
    return this.dataSource.query(
      `SELECT * FROM offers
       WHERE "salonId" = $1
         AND "isActive" = true
         AND ("validUntil" IS NULL OR "validUntil" > $2)
       ORDER BY "createdAt" DESC`,
      [salonId, now],
    );
  }

  async getAllActiveOffers() {
    const now = new Date();
    return this.dataSource.query(
      `SELECT * FROM offers
       WHERE "isActive" = true
         AND ("validUntil" IS NULL OR "validUntil" > $1)
       ORDER BY "createdAt" DESC
       LIMIT 50`,
      [now],
    );
  }
}
