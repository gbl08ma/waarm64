// How many steps the Collatz sequence takes from n down to 1.
unsigned collatz(unsigned long n) {
    unsigned steps = 0;
    while (n != 1) {
        n = n & 1 ? 3 * n + 1 : n >> 1;
        steps++;
    }
    return steps;
}
