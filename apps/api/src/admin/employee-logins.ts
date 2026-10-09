import { Injectable, Logger } from '@nestjs/common';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';

export type EmployeeRole = 'admin' | 'staff';

/**
 * Employee sign-in accounts (employees user pool). JoyBot's database stays the source of truth for
 * who is an employee and their role; this keeps Cognito in step. The email is the username.
 */
export interface EmployeeLogins {
  /** Creates the login and emails a temporary password (or re-enables an existing login). */
  invite(email: string, role: EmployeeRole): Promise<void>;
  resendInvite(email: string): Promise<void>;
  changeRole(email: string, from: EmployeeRole, to: EmployeeRole): Promise<void>;
  /** Blocks sign-in and revokes refresh tokens. */
  disable(email: string): Promise<void>;
  enable(email: string): Promise<void>;
}

export const EMPLOYEE_LOGINS = Symbol('EMPLOYEE_LOGINS');

@Injectable()
export class CognitoEmployeeLogins implements EmployeeLogins {
  private readonly client = new CognitoIdentityProviderClient({});

  constructor(private readonly userPoolId: string) {}

  async invite(email: string, role: EmployeeRole): Promise<void> {
    try {
      await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          DesiredDeliveryMediums: ['EMAIL'],
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
        }),
      );
    } catch (err) {
      // A former employee coming back: keep their login, just turn it on again.
      if (!(err instanceof UsernameExistsException)) throw err;
      await this.enable(email);
    }
    await this.client.send(new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: email, GroupName: role }));
  }

  async resendInvite(email: string): Promise<void> {
    await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: email,
        MessageAction: 'RESEND',
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
  }

  async changeRole(email: string, from: EmployeeRole, to: EmployeeRole): Promise<void> {
    await this.client.send(new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: email, GroupName: to }));
    await this.client.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: this.userPoolId, Username: email, GroupName: from }));
  }

  async disable(email: string): Promise<void> {
    await this.client.send(new AdminDisableUserCommand({ UserPoolId: this.userPoolId, Username: email }));
    await this.client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.userPoolId, Username: email }));
  }

  async enable(email: string): Promise<void> {
    await this.client.send(new AdminEnableUserCommand({ UserPoolId: this.userPoolId, Username: email }));
  }
}

/** Local development (AUTH_MODE=dev): there is no user pool; logins are not managed. */
export class LocalEmployeeLogins implements EmployeeLogins {
  private readonly logger = new Logger('EmployeeLogins');

  async invite(email: string): Promise<void> {
    this.logger.log(`(local) would invite ${email}`);
  }
  async resendInvite(email: string): Promise<void> {
    this.logger.log(`(local) would resend invite to ${email}`);
  }
  async changeRole(email: string, from: EmployeeRole, to: EmployeeRole): Promise<void> {
    this.logger.log(`(local) would move ${email} from ${from} to ${to}`);
  }
  async disable(email: string): Promise<void> {
    this.logger.log(`(local) would disable ${email}`);
  }
  async enable(email: string): Promise<void> {
    this.logger.log(`(local) would enable ${email}`);
  }
}
