import { useState, useEffect } from 'react';
import { useOfflineSync } from '@/hooks/use-offline-sync';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

interface LocalImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string | undefined;
}

export function LocalImage({ src, className, ...props }: LocalImageProps) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const { getLocalFileUrl } = useOfflineSync();

  useEffect(() => {
    let isMounted = true;
    setHasError(false);
    
    async function resolve() {
      if (!src) {
        if (isMounted) {
          setResolvedUrl(null);
          setIsLoading(false);
        }
        return;
      }

      // If it's a transient blob: URL, it's likely from a previous session and invalid.
      if (src.startsWith('blob:')) {
        console.warn('[LocalImage] Blocked transient blob URL from previous session:', src);
        if (isMounted) {
          setResolvedUrl(null);
          setIsLoading(false);
        }
        return;
      }

      if (src.startsWith('local-file://')) {
        const localId = src.replace('local-file://', '');
        const url = await getLocalFileUrl(localId);
        if (isMounted) {
          setResolvedUrl(url);
          setIsLoading(false);
        }
      } else {
        if (isMounted) {
          setResolvedUrl(src);
          setIsLoading(false);
        }
      }
    }

    resolve();

    return () => {
      isMounted = false;
    };
  }, [src, getLocalFileUrl]);

  if (isLoading) {
    return <Skeleton className={cn("w-full h-full", className)} />;
  }

  // Placeholder for unavailable images instead of broken icon
  if (!resolvedUrl || hasError) {
    return (
      <div className={cn("flex flex-col items-center justify-center bg-muted/50 text-muted-foreground text-[8px] leading-tight text-center p-1 border border-dashed rounded", className)}>
        <span>Sem prévia</span>
        <span className="opacity-50 mt-0.5">Sincronizando...</span>
      </div>
    );
  }

  return (
    <img
      src={resolvedUrl}
      className={className}
      onError={() => {
        console.warn('[LocalImage] Failed to load image:', resolvedUrl);
        setHasError(true);
      }}
      {...props}
    />
  );
}
