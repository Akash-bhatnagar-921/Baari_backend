export class CreateSalonDto {
  salonName!: string;
  address!: string;
  city!: string;
  pincode!: string;
  state!: string;
  landmark?: string;
  contactNumber!: string;
  shopEmail?: string;

  services!: string[];
  amenities!: string[];

  barbers!: {
    name: string;
    experience: number;
  }[];
}
