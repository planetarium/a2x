/**
 * GET /device/verify
 *
 * Browser page where the user enters the user_code displayed by the CLI
 * and approves the device. If user_code is in the query string
 * (verification_uri_complete), it's pre-filled.
 */

import { approveDeviceCode, getByUserCode } from '@/lib/device-store';
import { redirect } from 'next/navigation';

async function approve(formData: FormData) {
  'use server';
  const userCode = (formData.get('user_code') as string)?.trim().toUpperCase();
  if (!userCode) return redirect('/device/verify?error=missing');

  const entry = getByUserCode(userCode);
  if (!entry) return redirect('/device/verify?error=invalid');

  approveDeviceCode(userCode);
  return redirect('/device/verify?success=true');
}

export default async function DeviceVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string; error?: string; success?: string }>;
}) {
  const params = await searchParams;

  if (params.success) {
    return (
      <main style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.title}>Device Authorized</h1>
          <p style={styles.text}>
            You have successfully authorized the device.
            You can close this window and return to the CLI.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Device Authorization</h1>
        <p style={styles.text}>
          Enter the code displayed on your device to authorize access.
        </p>

        {params.error === 'invalid' && (
          <p style={styles.error}>Invalid or expired code. Please try again.</p>
        )}
        {params.error === 'missing' && (
          <p style={styles.error}>Please enter a code.</p>
        )}

        <form action={approve}>
          <input
            type="text"
            name="user_code"
            defaultValue={params.user_code ?? ''}
            placeholder="ABCD-1234"
            style={styles.input}
            autoFocus
            autoComplete="off"
          />
          <button type="submit" style={styles.button}>
            Authorize
          </button>
        </form>
      </div>
    </main>
  );
}

const styles = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
    fontFamily: 'system-ui, sans-serif',
    background: '#0a0a0a',
  } as const,
  card: {
    background: '#1a1a1a',
    borderRadius: '12px',
    padding: '40px',
    maxWidth: '400px',
    width: '100%',
    textAlign: 'center',
  } as const,
  title: {
    color: '#fff',
    fontSize: '24px',
    marginBottom: '12px',
  } as const,
  text: {
    color: '#888',
    fontSize: '14px',
    marginBottom: '24px',
    lineHeight: '1.5',
  } as const,
  error: {
    color: '#ef4444',
    fontSize: '14px',
    marginBottom: '16px',
  } as const,
  input: {
    display: 'block',
    width: '100%',
    padding: '12px 16px',
    fontSize: '20px',
    fontFamily: 'monospace',
    textAlign: 'center',
    letterSpacing: '4px',
    border: '1px solid #333',
    borderRadius: '8px',
    background: '#0a0a0a',
    color: '#fff',
    marginBottom: '16px',
    boxSizing: 'border-box',
  } as const,
  button: {
    display: 'block',
    width: '100%',
    padding: '12px',
    fontSize: '16px',
    fontWeight: 'bold',
    border: 'none',
    borderRadius: '8px',
    background: '#3b82f6',
    color: '#fff',
    cursor: 'pointer',
  } as const,
};
