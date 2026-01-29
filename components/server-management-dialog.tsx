"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Users,
  Globe,
  Mail,
  ShieldAlert,
  UserPlus,
  Trash2,
  Ban,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export function ServerManagementDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] w-[95vw] max-h-[95vh] h-[95vh] flex flex-col p-0 overflow-hidden bg-card border-none shadow-2xl rounded-3xl">
        <DialogHeader className="p-8 pb-4">
          <DialogTitle className="text-3xl font-bold tracking-tight">
            Server Management
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-lg">
            Control server-wide settings, users, and integrations.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="users" className="flex-1 flex flex-col min-h-0">
          <div className="px-8 mb-4">
            <TabsList className="bg-muted/50 p-1 rounded-2xl w-fit">
              <TabsTrigger
                value="users"
                className="rounded-xl px-6 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2"
              >
                <Users className="w-4 h-4" />
                User Management
              </TabsTrigger>
              <TabsTrigger
                value="proxy"
                className="rounded-xl px-6 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2"
              >
                <Globe className="w-4 h-4" />
                Proxy Settings
              </TabsTrigger>
              <TabsTrigger
                value="smtp"
                className="rounded-xl px-6 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2"
              >
                <Mail className="w-4 h-4" />
                SMTP / Email
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 min-h-0">
            <TabsContent
              value="users"
              className="h-full mt-0 focus-visible:outline-none"
            >
              <div className="px-8 flex flex-col h-full">
                <div className="flex justify-between items-center mb-6">
                  <div className="flex gap-2 flex-1 max-w-md">
                    <Input
                      placeholder="Search users..."
                      className="rounded-xl bg-muted/20"
                    />
                  </div>
                  <Button className="rounded-xl gap-2">
                    <UserPlus className="w-4 h-4" />
                    Invite User
                  </Button>
                </div>

                <ScrollArea className="flex-1">
                  <div className="space-y-3 pb-8">
                    {/* Placeholder Users */}
                    {[1, 2, 3].map((u) => (
                      <div
                        key={u}
                        className="flex items-center gap-4 p-4 rounded-2xl bg-muted/30 border border-transparent hover:border-border transition-all"
                      >
                        <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold">
                          U{u}
                        </div>
                        <div className="flex-1">
                          <div className="font-bold">User {u}</div>
                          <div className="text-xs text-muted-foreground">
                            user{u}@example.com
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="rounded-lg text-amber-500 hover:bg-amber-500/10"
                          >
                            <Ban className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="rounded-lg text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    <div className="p-8 text-center border-2 border-dashed border-muted rounded-3xl">
                      <p className="text-muted-foreground">
                        User management logic will be implemented in a future
                        mission.
                      </p>
                    </div>
                  </div>
                </ScrollArea>
              </div>
            </TabsContent>

            <TabsContent value="proxy" className="px-8 py-6 space-y-6">
              <div className="max-w-2xl space-y-6">
                <div className="space-y-2">
                  <h4 className="text-lg font-semibold">Global Proxy</h4>
                  <p className="text-sm text-muted-foreground">
                    Route all RSS fetching through a specific proxy server.
                  </p>
                </div>
                <div className="grid gap-4 p-6 rounded-3xl bg-muted/20 border">
                  <div className="space-y-2">
                    <Label>Proxy URL</Label>
                    <Input
                      placeholder="http://proxy.example.com:8080"
                      className="rounded-xl"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Authentication (Optional)</Label>
                    <div className="flex gap-4">
                      <Input placeholder="Username" className="rounded-xl" />
                      <Input
                        type="password"
                        placeholder="Password"
                        className="rounded-xl"
                      />
                    </div>
                  </div>
                  <Button className="w-fit rounded-xl px-8 ml-auto">
                    Save Proxy Settings
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="smtp" className="px-8 py-6 space-y-6">
              <div className="max-w-2xl space-y-6">
                <div className="space-y-2">
                  <h4 className="text-lg font-semibold">SMTP Configuration</h4>
                  <p className="text-sm text-muted-foreground">
                    Used for invitations, password resets, and notifications.
                  </p>
                </div>
                <div className="grid gap-4 p-6 rounded-3xl bg-muted/20 border">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>SMTP Host</Label>
                      <Input
                        placeholder="smtp.gmail.com"
                        className="rounded-xl"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Port</Label>
                      <Input placeholder="587" className="rounded-xl" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>From Email</Label>
                    <Input
                      placeholder="noreply@feedferret.cloud"
                      className="rounded-xl"
                    />
                  </div>
                  <Button className="w-fit rounded-xl px-8 ml-auto">
                    Update SMTP Settings
                  </Button>
                </div>
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
