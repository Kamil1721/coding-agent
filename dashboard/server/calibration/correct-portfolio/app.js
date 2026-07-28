// Scroll-driven reveal: IntersectionObserver + staggered rAF, not a stock fade.
const els=[...document.querySelectorAll('.project,#contact')];
els.forEach(e=>e.classList.add('reveal'));
const io=new IntersectionObserver((rows)=>{
  rows.filter(r=>r.isIntersecting).forEach((r,i)=>{
    requestAnimationFrame(()=>setTimeout(()=>r.target.classList.add('in'), i*90));
    io.unobserve(r.target);
  });
},{rootMargin:'-10% 0px'});
els.forEach(e=>io.observe(e));
document.getElementById('contact-form').addEventListener('submit',(ev)=>{
  ev.preventDefault();
  document.getElementById('confirm').hidden=false;
});
