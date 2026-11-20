// Adds up the bytes of a buffer.
unsigned sum(const unsigned char *p, unsigned long n) {
    unsigned s = 0;
    while (n--)
        s += *p++;
    return s;
}
