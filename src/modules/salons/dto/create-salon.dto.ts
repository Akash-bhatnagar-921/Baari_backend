import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

class BarberDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsInt()
  @Min(0)
  experience!: number;

  @IsOptional()
  @IsString()
  workingDays?: string;
}

class ServiceDto {
  @IsOptional()
  @IsString()
  serviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  serviceName?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  duration?: number;
}

export class CreateSalonDto {
  // ── Salon details ─────────────────────────────────────────────────────────
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  salonName!: string;

  @IsString()
  @MaxLength(255)
  address!: string;

  @IsString()
  @MaxLength(80)
  city!: string;

  @IsString()
  @MaxLength(80)
  state!: string;

  @IsString()
  @MaxLength(10)
  pincode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  landmark?: string;

  // ── Contact ───────────────────────────────────────────────────────────────
  @IsString()
  @MinLength(10)
  @MaxLength(15)
  contactNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(254)
  shopEmail?: string;

  // ── Business owner (ownership records only — not used for login) ──────────
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  ownerName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(15)
  ownerPhone?: string;

  // ── Working hours ─────────────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  openingTime?: string;

  @IsOptional()
  @IsString()
  closingTime?: string;

  @IsOptional()
  @IsString()
  workingDays?: string;

  // ── Services (array of service ID strings or name strings) ───────────────
  @IsArray()
  @IsString({ each: true })
  services!: string[];

  // ── Amenities (array of name strings) ────────────────────────────────────
  @IsArray()
  @IsString({ each: true })
  amenities!: string[];

  // ── Barbers ───────────────────────────────────────────────────────────────
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BarberDto)
  barbers!: BarberDto[];

  // ── Franchise (optional) ──────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  franchiseId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  franchiseName?: string;

  // ── GPS coordinates from device (optional) ────────────────────────────────
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;
}
