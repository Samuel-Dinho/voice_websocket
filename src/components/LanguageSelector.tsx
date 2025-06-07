"use client";

import type { Language } from "@/lib/languages";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

interface LanguageSelectorProps {
  id: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  languages: Language[];
  disabled?: boolean;
}

export function LanguageSelector({
  id,
  label,
  value,
  onValueChange,
  languages,
  disabled = false,
}: LanguageSelectorProps) {
  return (
    <div className="flex flex-col space-y-2">
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full md:w-[200px] bg-card">
          <SelectValue placeholder="Select language" />
        </SelectTrigger>
        <SelectContent>
          {languages.map((lang) => (
            <SelectItem key={lang.code} value={lang.code}>
              {lang.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
