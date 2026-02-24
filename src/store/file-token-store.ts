import fs from 'fs/promises';
import path from 'path';
import { getConfigDir, CONFIG_FILE_PERMISSION } from '../constants.js';
import type { TokenStore, UserTokenData } from './token-store.js';

const TOKEN_FILE_NAME = 'user-tokens.json';

function getTokenFilePath(): string {
  return path.join(getConfigDir(), TOKEN_FILE_NAME);
}

type TokenMap = Record<string, UserTokenData>;

async function readTokenFile(): Promise<TokenMap> {
  try {
    const data = await fs.readFile(getTokenFilePath(), 'utf8');
    return JSON.parse(data) as TokenMap;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeTokenFile(map: TokenMap): Promise<void> {
  const filePath = getTokenFilePath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(map, null, 2), {
    mode: CONFIG_FILE_PERMISSION,
  });
}

export class FileTokenStore implements TokenStore {
  async save(apiKey: string, data: UserTokenData): Promise<void> {
    const map = await readTokenFile();
    map[apiKey] = data;
    await writeTokenFile(map);
  }

  async load(apiKey: string): Promise<UserTokenData | null> {
    const map = await readTokenFile();
    return map[apiKey] ?? null;
  }

  async delete(apiKey: string): Promise<void> {
    const map = await readTokenFile();
    delete map[apiKey];
    await writeTokenFile(map);
  }

  async exists(apiKey: string): Promise<boolean> {
    const map = await readTokenFile();
    return apiKey in map;
  }
}
