export class CreateSalonDto {
  // Salon details
  salonName!: string;
  address!: string;
  city!: string;
  pincode!: string;
  state!: string;
  landmark?: string;

  // The salon's own phone number — used as the OTP login credential.
  // Every salon must have a unique phone; the professional logs in with this.
  contactNumber!: string;

  shopEmail?: string;

  // Business owner — for ownership records only, NOT used for app login.
  // One owner can register multiple salons with the same ownerPhone.
  ownerName!: string;
  ownerPhone?: string;

  // Services, amenities, barbers (name strings)
  services!: string[];
  amenities!: string[];
  barbers!: { name: string; experience: number }[];

  // Working hours (optional)
  openingTime?: string; // e.g. "09:00"
  closingTime?: string; // e.g. "21:00"
  workingDays?: string; // e.g. "Mon,Tue,Wed,Thu,Fri,Sat"

  // Franchise (optional)
  franchiseId?: string; // UUID of existing SalonFranchise
  franchiseName?: string; // name to create a new SalonFranchise if no franchiseId

  // GPS coordinates from device (optional)
  latitude?: number;
  longitude?: number;
}
