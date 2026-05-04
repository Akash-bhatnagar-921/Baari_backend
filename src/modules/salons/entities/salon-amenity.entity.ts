import { Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Salon } from './salon.entity';
import { Amenity } from './amenity.entity';

@Entity('salon_amenities')
export class SalonAmenity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Salon, { onDelete: 'CASCADE' })
  salon!: Salon;

  @ManyToOne(() => Amenity)
  amenity!: Amenity;
}