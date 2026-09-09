package ir.taprasystem.employee;

public final class TrackingRequestScopeTest {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        TrackingRequestScope scope = new TrackingRequestScope();
        check(!scope.isCurrent(null, "a"), "stopped service accepted work");
        scope.start("a", "shift-1");
        TrackingRequestScope.Snapshot first = scope.capture();
        check(scope.isCurrent(first, "a"), "current request was rejected");
        check(!scope.isCurrent(first, "b"), "request leaked to a different account");
        scope.start("a", "shift-1");
        check(scope.isCurrent(first, "a"), "refresh invalidated the same shift");
        scope.start("a", "shift-2");
        check(!scope.isCurrent(first, "a"), "old shift can stop the new shift");
        check(first.workSessionId.equals("shift-1"), "snapshot changed after dispatch");
        scope.start("b", "shift-b");
        check(!scope.isCurrent(first, "b"), "old account can notify the new account");
        scope.start("a", "shift-1");
        check(!scope.isCurrent(first, "a"), "returning to an account revived an obsolete response");
        TrackingRequestScope.Snapshot restarted = scope.capture();
        scope.invalidate();
        check(!scope.isCurrent(restarted, "a"), "destroyed service still accepts callbacks");
        scope.start("a", "shift-1");
        check(!scope.isCurrent(restarted, "a"), "stop/restart reused the same identity");
        check(scope.isCurrent(scope.capture(), "a"), "new session failed");
        System.out.println("Tracking request lifecycle assertions passed");
    }
}
