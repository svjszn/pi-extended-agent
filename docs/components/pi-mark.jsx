export function PiMark({ className, size = 28 }) {
  return (
    <svg className={className} width={size} height={size} viewBox="165 165 470 470" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
      <path d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}
