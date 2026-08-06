'use server';

import { revalidatePath } from 'next/cache';

/**
 * Probe again without restarting anything.
 *
 * The page is uncached, so discarding its render is all a re-probe needs. An
 * operator who has just changed a setting on the Renovate server should not
 * have to restart Withe to find out whether it worked.
 */
export async function reprobe(): Promise<void> {
  revalidatePath('/preflight');
}
