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

export class RegisterDto {
  @IsString()
  @Matches(/^\d{10}$/, { message: 'Please enter a valid 10 digit number' })
  phone!: string;

  @IsString()
  @IsIn(['customer', 'professional'])
  role!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Please enter a valid email' })
  email?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  age?: number;

  @IsOptional()
  @IsString()
  gender?: string;

  @IsBoolean()
  hasAcceptedTerms!: boolean;

  @IsOptional()
  @IsString()
  termsVersion?: string;
}
