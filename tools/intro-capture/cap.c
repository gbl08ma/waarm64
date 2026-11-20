// Caps the values above a limit and counts them: a loop with a branch inside.
unsigned cap(int *v, unsigned long n, int limit) {
    unsigned capped = 0;
    for (; n--; v++) {
        if (*v > limit) {
            *v = limit;
            capped++;
        }
    }
    return capped;
}
