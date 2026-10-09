import { ConflictException, Logger } from '@nestjs/common';
import { AdminUpdateUserAttributesCommand, AliasExistsException, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

/** Keeps the customer's Cognito login in step with contacts verified in JoyBot (sign in with either). */
export interface CustomerLogins {
  setVerifiedContact(cognitoSub: string, type: 'email' | 'phone', value: string): Promise<void>;
}
export const CUSTOMER_LOGINS = Symbol('CUSTOMER_LOGINS');

export class CognitoCustomerLogins implements CustomerLogins {
  private readonly client = new CognitoIdentityProviderClient({});

  constructor(private readonly userPoolId: string) {}

  async setVerifiedContact(cognitoSub: string, type: 'email' | 'phone', value: string): Promise<void> {
    const [attr, verified] = type === 'email' ? ['email', 'email_verified'] : ['phone_number', 'phone_number_verified'];
    try {
      await this.client.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: this.userPoolId,
          Username: cognitoSub,
          UserAttributes: [
            { Name: attr, Value: value },
            { Name: verified, Value: 'true' },
          ],
        }),
      );
    } catch (err) {
      if (err instanceof AliasExistsException) throw new ConflictException('This contact is already used by another account');
      throw err;
    }
  }
}

export class LocalCustomerLogins implements CustomerLogins {
  private readonly logger = new Logger('CustomerLogins');
  async setVerifiedContact(sub: string, type: 'email' | 'phone'): Promise<void> {
    this.logger.log(`(local) would set verified ${type} on login ${sub}`);
  }
}
