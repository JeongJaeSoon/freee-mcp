export interface UserTokenData {
  apiKey: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  companyId: string;
  userId?: string;
  createdAt: number;
}

export interface TokenStore {
  save(apiKey: string, data: UserTokenData): Promise<void>;
  load(apiKey: string): Promise<UserTokenData | null>;
  delete(apiKey: string): Promise<void>;
  exists(apiKey: string): Promise<boolean>;
}
