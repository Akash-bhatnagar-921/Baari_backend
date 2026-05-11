export class RequestLoginOtpDto {
  phone!: string;
}

export class VerifyLoginOtpDto {
  phone!: string;
  otp!: string;
}

export class RequestRegisterOtpDto {
  phone!: string;
  email!: string;
}

export class VerifyRegisterOtpDto {
  phone!: string;
  email!: string;
  otp!: string;
  role!: string;
  name!: string;
  age!: number;
  gender!: string;
  hasAcceptedTerms!: boolean;
}
