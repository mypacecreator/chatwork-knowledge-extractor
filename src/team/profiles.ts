import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type TeamRole = 'senior' | 'member' | 'junior';

export interface TeamProfile {
  name: string;
  role: TeamRole;
}

export interface TeamProfilesConfig {
  profiles: Record<string, TeamProfile>;
}

export interface ResolvedRole {
  role: TeamRole;
  roleLabel: string;
}

const ROLE_LABELS: Record<TeamRole, string> = {
  senior: 'Senior',
  member: 'Member',
  junior: 'Junior',
};

export class TeamProfileManager {
  private profiles: Map<string, TeamProfile> = new Map();

  constructor(configPath?: string) {
    this.load(configPath);
  }

  private load(customPath?: string): void {
    // カスタムパスが指定されている場合
    if (customPath && existsSync(customPath)) {
      this.parseFile(customPath);
      return;
    }

    // デフォルトパス（プロジェクトルート/config/team-profiles.json）
    const projectRoot = join(__dirname, '..', '..');
    const defaultPath = join(projectRoot, 'config', 'team-profiles.json');

    if (existsSync(defaultPath)) {
      this.parseFile(defaultPath);
    } else {
      console.log('[TeamProfile] チームプロファイル未設定（全員memberとして扱います）');
    }
  }

  private parseFile(filePath: string): void {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const config: TeamProfilesConfig = JSON.parse(content);

      for (const [accountId, profile] of Object.entries(config.profiles)) {
        if (!this.isValidRole(profile.role)) {
          console.warn(`[TeamProfile] 不正なロール "${profile.role}" (account_id: ${accountId})、memberとして扱います`);
          profile.role = 'member';
        }
        this.profiles.set(accountId, profile);
      }

      console.log(`[TeamProfile] ${this.profiles.size}名のプロファイル読み込み完了`);
    } catch (e) {
      console.error(`[TeamProfile] 読み込みエラー: ${filePath}`);
    }
  }

  private isValidRole(role: string): role is TeamRole {
    return ['senior', 'member', 'junior'].includes(role);
  }

  /**
   * account_idからロールを解決する
   * 未登録の場合はmemberを返す
   */
  resolveRole(accountId: number): ResolvedRole {
    const key = String(accountId);
    const profile = this.profiles.get(key);
    const role: TeamRole = profile?.role ?? 'member';

    return {
      role,
      roleLabel: ROLE_LABELS[role],
    };
  }

  /**
   * プロファイルが1件以上登録されているか
   */
  hasProfiles(): boolean {
    return this.profiles.size > 0;
  }
}
