import type { UserProfile, UserRecord } from '../types/user.js';

export function toUserProfile(user: UserRecord, email: string): UserProfile {
  return {
    id: user.id,
    email,
    full_name: user.fullName,
    avatar_url: user.avatarUrl,
    initial_balance: user.initialBalance,
    currency: user.currency,
    timezone: user.timezone,
    locale: user.locale,
    onboarding_completed_at: user.onboardingCompletedAt?.toISOString() ?? null,
    created_at: user.createdAt.toISOString(),
  };
}
