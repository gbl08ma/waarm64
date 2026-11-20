// Moves a point by its velocity: loads and stores through one pointer.
struct point {
    long x, y, vx, vy;
};

void move(struct point *p) {
    p->x += p->vx;
    p->y += p->vy;
}
