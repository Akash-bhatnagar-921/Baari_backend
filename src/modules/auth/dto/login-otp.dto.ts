import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class RequestLoginOtpDto {
  @IsString()
  @Matches(/^\d{10}$/, { message: 'Please enter a valid 10 digit number' })
  phone!: string;
}

export class VerifyLoginOtpDto {
  @IsString()
  @Matches(/^\d{10}$/, { message: 'Please enter a valid 10 digit number' })
  phone!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'Please enter a valid 6 digit OTP' })
  otp!: string;
}

export class RequestRegisterOtpDto {
  @IsString()
  @Matches(/^\d{10}$/, { message: 'Please enter a valid 10 digit number' })
  phone!: string;

  @IsEmail({}, { message: 'Please enter a valid email' })
  email!: string;
}

export class VerifyRegisterOtpDto {
  @IsString()
  @Matches(/^\d{10}$/, { message: 'Please enter a valid 10 digit number' })
  phone!: string;

  @IsEmail({}, { message: 'Please enter a valid email' })
  email!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'Please enter a valid 6 digit OTP' })
  otp!: string;

  @IsString()
  @IsIn(['customer', 'professional'])
  role!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsInt()
  @Min(1)
  @Max(120)
  age!: number;

  @IsString()
  @IsNotEmpty()
  gender!: string;

  @IsBoolean()
  hasAcceptedTerms!: boolean;

  @IsOptional()
  @IsString()
  termsVersion?: string;
}
