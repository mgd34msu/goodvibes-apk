import { NativeModules, Platform } from 'react-native';

interface GoodVibesQrScannerModule {
  scanQRCode(): Promise<string>;
}

interface NativeScannerError {
  readonly code?: string;
  readonly message?: string;
}

const nativeScanner = NativeModules.GoodVibesQrScanner as GoodVibesQrScannerModule | undefined;

export function isGoodVibesQrScannerAvailable(): boolean {
  return Platform.OS === 'android' && typeof nativeScanner?.scanQRCode === 'function';
}

export async function scanGoodVibesQrCode(): Promise<string> {
  if (!isGoodVibesQrScannerAvailable()) {
    throw new Error('QR scanning is not available on this device.');
  }

  return await nativeScanner!.scanQRCode();
}

export function isGoodVibesQrScanCancelled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as NativeScannerError).code === 'E_CANCELLED';
}

export function formatGoodVibesQrScanError(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as NativeScannerError;
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message.trim();
    }
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return 'QR scan failed.';
}
