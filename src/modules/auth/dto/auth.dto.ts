export class RegisterDto {
  phone!: string;
  role!: string;

  fullName!: string;
  email?: string;
  age?: number;
  gender?: string;

  hasAcceptedTerms!: boolean;
}