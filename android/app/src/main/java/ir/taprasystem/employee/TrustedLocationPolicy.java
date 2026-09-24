package ir.taprasystem.employee;

/** Pure policy shared by the Android service and the local Java compatibility tests. */
final class TrustedLocationPolicy {
    static final float MAX_ACCURACY_METERS = 100f;

    private TrustedLocationPolicy() { }

    static String rejectionReason(boolean precisePermission, boolean mocked, float accuracyMeters) {
        if (mocked) return "mock_location";
        if (!precisePermission) return "approximate_location";
        if (Float.isNaN(accuracyMeters) || Float.isInfinite(accuracyMeters) || accuracyMeters < 0f) return "invalid_accuracy";
        if (accuracyMeters > MAX_ACCURACY_METERS) return "approximate_location";
        return null;
    }

    static boolean isTrusted(boolean precisePermission, boolean mocked, float accuracyMeters) {
        return rejectionReason(precisePermission, mocked, accuracyMeters) == null;
    }
}
