import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('amenities')
export class Amenity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  name!: string;
}