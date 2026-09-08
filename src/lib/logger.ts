export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogData {
  message: string;
  level?: LogLevel;
  context?: any;
  stack_trace?: string;
}

const getUserEmail = (): string | null => {
  try {
    const promoter = localStorage.getItem('promotor_employee');
    if (promoter) {
      const p = JSON.parse(promoter);
      if (p?.email) return p.email;
    }
    const agency = localStorage.getItem('agency_user');
    if (agency) {
      const a = JSON.parse(agency);
      if (a?.email) return a.email;
    }
    const supermarket = localStorage.getItem('supermarket_user');
    if (supermarket) {
      const s = JSON.parse(supermarket);
      if (s?.email) return s.email;
    }
    return localStorage.getItem('user_email');
  } catch {
    return null;
  }
};

// Muitos colaboradores do app do promotor fazem login só com CPF e nunca têm
// e-mail cadastrado — nesse caso getUserEmail() volta null e o log ficava sem
// nenhuma identificação ("Sistema"). O nome fica disponível de qualquer forma.
const getUserName = (): string | null => {
  try {
    const promoter = localStorage.getItem('promotor_employee');
    if (promoter) {
      const p = JSON.parse(promoter);
      if (p?.name) return p.name;
    }
    const agency = localStorage.getItem('agency_user');
    if (agency) {
      const a = JSON.parse(agency);
      if (a?.name) return a.name;
    }
    const supermarket = localStorage.getItem('supermarket_user');
    if (supermarket) {
      const s = JSON.parse(supermarket);
      if (s?.name) return s.name;
    }
    return null;
  } catch {
    return null;
  }
};

const getUserId = (): string | null => {
  try {
    const promoter = localStorage.getItem('promotor_employee');
    if (promoter) {
      const p = JSON.parse(promoter);
      if (p?.id) return p.id;
    }
    return null;
  } catch {
    return null;
  }
};

const getDeviceInfo = () => ({
  userAgent: navigator.userAgent,
  language: navigator.language,
  platform: (navigator as any).platform,
  vendor: navigator.vendor,
  screen: `${window.screen.width}x${window.screen.height}`,
  online: navigator.onLine,
});

export const logger = {
  async log({ message, level = 'info', context = {}, stack_trace }: LogData) {
    try {
      const consoleMethod = level === 'fatal' ? 'error' : (level === 'warn' ? 'warn' : (level === 'error' ? 'error' : 'log'));
      // eslint-disable-next-line no-console
      (console as any)[consoleMethod](`[${level.toUpperCase()}] ${message}`, context);

      const email = getUserEmail();
      const name = getUserName();
      const employeeId = getUserId();
      const device = getDeviceInfo();

      // Remote persistence to our backend logs
      const endpoint = '/api/rh/client-logs';
      const body = {
        level,
        event: message.substring(0, 100),
        payload: {
          message,
          user_email: email,
          employee_name: name,
          employee_id: employeeId,
          device,
          context,
          error: stack_trace ? { stack: stack_trace } : undefined
        }
      };

      // Non-blocking fire and forget
      fetch(`${import.meta.env.VITE_API_URL || ''}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth_token') || localStorage.getItem('promotor_token') || ''}`
        },
        body: JSON.stringify(body)
      }).catch(() => {});
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to process log:', err);
    }
  },

  debug(message: string, context?: any) {
    return this.log({ message, level: 'debug', context });
  },
  info(message: string, context?: any) {
    return this.log({ message, level: 'info', context });
  },
  warn(message: string, context?: any) {
    return this.log({ message, level: 'warn', context });
  },
  error(message: string, context?: any, error?: Error) {
    return this.log({ message, level: 'error', context, stack_trace: error?.stack });
  },
  fatal(message: string, context?: any, error?: Error) {
    return this.log({ message, level: 'fatal', context, stack_trace: error?.stack });
  },
};
