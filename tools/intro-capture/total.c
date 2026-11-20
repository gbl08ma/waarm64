// Adds up an array of doubles.
double total(const double *v, unsigned long n) {
    double t = 0;
    while (n--)
        t += *v++;
    return t;
}
