package com.pellux.goodvibescompanion

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.zxing.integration.android.IntentIntegrator

class QrScannerModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  private var pendingPromise: Promise? = null

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = MODULE_NAME

  @ReactMethod
  fun scanQRCode(promise: Promise) {
    if (pendingPromise != null) {
      promise.reject("E_BUSY", "A QR scan is already in progress.")
      return
    }

    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "QR scanning requires an active screen.")
      return
    }

    pendingPromise = promise

    try {
      val intent =
          IntentIntegrator(activity)
              .setCaptureActivity(QrScanActivity::class.java)
              .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
              .setPrompt("Scan GoodVibes QR")
              .setBeepEnabled(false)
              .setOrientationLocked(true)
              .createScanIntent()

      @Suppress("DEPRECATION")
      activity.startActivityForResult(intent, IntentIntegrator.REQUEST_CODE)
    } catch (error: Exception) {
      pendingPromise = null
      promise.reject("E_START_FAILED", "Could not open the QR scanner.", error)
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    val result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data) ?: return
    val promise = pendingPromise ?: return
    pendingPromise = null

    val contents = result.contents?.trim()
    if (contents.isNullOrEmpty()) {
      promise.reject("E_CANCELLED", "QR scan cancelled.")
      return
    }

    promise.resolve(contents)
  }

  override fun onNewIntent(intent: Intent) = Unit

  companion object {
    private const val MODULE_NAME = "GoodVibesQrScanner"
  }
}
