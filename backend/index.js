// IMPORTANT: dotenv must load FIRST so process.env is populated before the
// mail transporters below read it (this was a bug: it used to load at line ~129).
require("dotenv").config();

const dns = require("dns");
const https = require("https");

// Force IPv4 result order globally across Node.js networking
// This prevents Brevo API / SMTP from failing due to IPv6 connection timeouts on IPv4-only networks
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

// Custom DNS lookup function enforcing IPv4 (AF_INET)
const ipv4DnsLookup = (hostname, options, callback) => {
  return dns.lookup(hostname, { ...options, family: 4 }, callback);
};

// Dedicated IPv4 HTTP/HTTPS agent for Brevo REST API calls
const brevoIpv4Agent = new https.Agent({ family: 4, keepAlive: true });

const express = require("express");
const http = require("http");
const app = express();

// Behind Render proxy in production — needed for correct client IPs in rate limiting
app.set("trust proxy", 1);

const crypto = require("crypto");

// Escape user input before embedding into RegExp — prevents both regex-injection
// and accidental mismatches (e.g. "+" in plus-addressed emails like name+tag@gmail.com)
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcrypt");
const XLSX = require("xlsx");
const jwt = require('jsonwebtoken');

const {
  authorizeRoles,
  authenticateToken,
  generateToken,
} = require("./middleware/auth");

// Models
const Users = require("./models/users");
const StudentProfile = require("./models/studentSchema");
const CampusStats = require("./models/campusStats");
const Company = require("./models/company");
const CompanyDrives = require("./models/companyDrives");
const DepartmentSchema = require("./models/departmentSchema");
const PlacedStudents = require("./models/PlacedStudents");
const YearlyPlacements = require("./models/yearlyPlacements");
const ActualStudentsData = require("./models/ActualStudentsData");
const otpSchema = require("./models/otpSchema");
const Feedback = require("./models/Feedback");

// =========== socket setup =======================
const server = http.createServer(app);

const { initializeSocket, onlineUsers, getIO } = require("./socket");
const io = initializeSocket(server);

// ====================== SENDING EMAIL ===========================
const nodemailer = require("nodemailer");

// Shared SMTP timeouts / pooling options with IPv4 family enforcement
const SMTP_OPTIONS = {
  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 30000,
  pool: true,
  maxConnections: 3,
  maxMessages: 50,
  family: 4,
  lookup: ipv4DnsLookup,
};

// Brevo REST API v3 sender function (forces IPv4 over HTTPS port 443)
async function sendBrevoApiEmail({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.EMAIL || process.env.BREVO_SMTP_LOGIN;
  const senderName = process.env.EMAIL_SENDER_NAME || "TNPC Portal";

  if (!apiKey) {
    throw new Error("BREVO_API_KEY is not configured");
  }
  if (!senderEmail) {
    throw new Error("Sender email (EMAIL or BREVO_SMTP_LOGIN) is not configured");
  }

  const postData = JSON.stringify({
    sender: { name: senderName, email: senderEmail },
    to: [{ email: to }],
    subject: subject,
    htmlContent: html,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.brevo.com",
        port: 443,
        path: "/v3/smtp/email",
        method: "POST",
        agent: brevoIpv4Agent,
        headers: {
          accept: "application/json",
          "api-key": apiKey,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(body);
              resolve({ success: true, messageId: parsed.messageId });
            } catch (e) {
              resolve({ success: true, body });
            }
          } else {
            reject(new Error(`Brevo REST API error (${res.statusCode}): ${body}`));
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(new Error(`Brevo REST API IPv4 request failed: ${err.message}`));
    });

    req.write(postData);
    req.end();
  });
}

// ---- Provider selection ----------------------------------------------------
// Priority: 1) Brevo (API / SMTP)  2) Gmail SMTP (if EMAIL_PASSWORD set)
// sendEmail() additionally falls back to SendGrid (if SENDGRID_API_KEY set).
let transporter = null;   // primary provider
let gmailFallback = null; // secondary provider

if (process.env.BREVO_API_KEY) {
  transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST || "smtp-relay.brevo.com",
    port: Number(process.env.BREVO_SMTP_PORT) || 587,
    secure: false,
    family: 4,
    lookup: ipv4DnsLookup,
    auth: {
      // Brevo SMTP login = email used to create the Brevo account
      user: process.env.BREVO_SMTP_LOGIN || process.env.EMAIL,
      // Brevo SMTP key (starts with "xsmtpsib-") or API key
      pass: process.env.BREVO_API_KEY,
    },
    ...SMTP_OPTIONS,
  });
  console.log("✅ Brevo (REST API & SMTP) configured as PRIMARY email provider (IPv4 forced)");
}

if (process.env.EMAIL && process.env.EMAIL_PASSWORD) {
  const gmailTransporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465, // SSL
    secure: true,
    family: 4,
    lookup: ipv4DnsLookup,
    auth: {
      user: process.env.EMAIL,
      pass: process.env.EMAIL_PASSWORD, // 16-char Gmail App Password
    },
    tls: { rejectUnauthorized: false },
    ...SMTP_OPTIONS,
  });

  if (!transporter) {
    transporter = gmailTransporter;
    console.log("✅ Gmail SMTP configured as PRIMARY email provider (IPv4 forced)");
  } else {
    gmailFallback = gmailTransporter;
    console.log("✅ Gmail SMTP configured as FALLBACK email provider (IPv4 forced)");
  }
}

if (!transporter && !process.env.BREVO_API_KEY) {
  console.warn("⚠️  No email provider configured. Set BREVO_API_KEY or EMAIL + EMAIL_PASSWORD.");
}

// SendGrid setup (optional - use as fallback)
let sgMail = null;
try {
  sgMail = require('@sendgrid/mail');
  if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    console.log("✅ SendGrid initialized");
  }
} catch (error) {
  console.log("ℹ️ SendGrid not installed or configured");
}

// Verify SMTP connection on startup with retry
let transporterVerified = false;

function verifyTransporter(retryCount = 0) {
  if (!transporter) return;
  transporter.verify((error, success) => {
    if (error) {
      console.error(`❌ SMTP verification failed (attempt ${retryCount + 1}):`, error.message);
      if (retryCount < 3) {
        console.log(`🔄 Retrying SMTP verification in 5 seconds...`);
        setTimeout(() => verifyTransporter(retryCount + 1), 5000);
      } else {
        console.error("❌ SMTP verification failed after 3 attempts. Emails may fall back to REST API.");
      }
    } else {
      console.log("✅ SMTP server is ready to accept messages");
      transporterVerified = true;
    }
  });
}

// Call verification
verifyTransporter();

// ================= CORS =================
// FIXED: Proper CORS configuration
app.use(cors());

app.set("io", io);

// Middleware
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// DB Connection
mongoose
  .connect(process.env.MONGOURL)
  .then(() => console.log("✅ Database connected"))
  .catch((err) => console.log("❌ Database connection error:", err));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
});

app.get("/", (req, res) => {
  res.send("Backend Connected Successfully");
});

// ============ RATE LIMITERS (OTP abuse / brute-force protection) ==============
const { rateLimit } = require("express-rate-limit");

const otpRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,                   // 5 OTP requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many OTP requests. Please try again after some time." },
});

const otpActionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,                  // verify/reset attempts headroom per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again after some time." },
});

// ================= FORGOT PASSWORD - REQUEST OTP ===============================
app.post("/forgot-password", otpRequestLimiter, async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      message: "Email is required"
    });
  }

  try {
    const existingUser = await Users.findOne({ 
      email: { $regex: new RegExp(`^${escapeRegex(email.trim())}$`, "i") } 
    });
    
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: "No account found with this email address"
      });
    }

    // Server-side resend cooldown (60s) — mirrors the frontend timer
    const latestOtp = await otpSchema.findOne({ email: email.trim() }).sort({ createdAt: -1 });
    if (latestOtp && Date.now() - new Date(latestOtp.createdAt).getTime() < 60 * 1000) {
      return res.status(429).json({
        success: false,
        message: "OTP was sent recently. Please wait 60 seconds before requesting again."
      });
    }

    // Cryptographically secure 6-digit OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    const expiry = new Date(Date.now() + 5 * 60 * 1000);

    await otpSchema.deleteMany({ email: email.trim() });

    await otpSchema.create({
      email: email.trim(),
      otp: otp,
      expiry: expiry
    });

    await sendEmail({
      to: email.trim(),
      subject: "Password Reset OTP - TNPC Portal",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f9f9f9; border-radius: 10px;">
          <div style="background: linear-gradient(135deg, #1a56db, #7c3aed); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 24px;">🔐 Password Reset</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p style="color: #4a5568; font-size: 16px;">Hello ${existingUser.name || 'User'},</p>
            <p style="color: #4a5568; font-size: 16px;">You requested to reset your password. Use the OTP below to proceed:</p>
            
            <div style="background: #f7fafc; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
              <h2 style="color: #1a56db; font-size: 36px; letter-spacing: 8px; margin: 0;">${otp}</h2>
            </div>
            
            <p style="color: #718096; font-size: 14px; text-align: center;">
              This OTP will expire in <strong>5 minutes</strong>.
            </p>
            
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
            
            <p style="color: #718096; font-size: 12px; text-align: center;">
              If you didn't request this password reset, please ignore this email.
            </p>
          </div>
        </div>
      `
    });

    res.status(200).json({
      success: true,
      message: "OTP sent successfully to your email"
    });

  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send OTP. Please try again later."
    });
  }
});

// ============== VERIFY OTP ===============================
app.post("/verify-otp", otpActionLimiter, async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({
      success: false,
      message: "Email and OTP are required"
    });
  }

  try {
    // Look up by email only, so wrong guesses can be counted per OTP
    const otpRecord = await otpSchema.findOne({ email: email.trim() });

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP or no OTP requested. Please request a new one."
      });
    }

    if (new Date() > otpRecord.expiry) {
      await otpSchema.deleteOne({ _id: otpRecord._id });
      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please request a new one."
      });
    }

    // Brute-force protection: max 5 wrong attempts per OTP
    if (otpRecord.otp !== otp.trim()) {
      otpRecord.attempts = (otpRecord.attempts || 0) + 1;
      if (otpRecord.attempts >= 5) {
        await otpSchema.deleteOne({ _id: otpRecord._id });
        return res.status(400).json({
          success: false,
          message: "Too many wrong attempts. Please request a new OTP."
        });
      }
      await otpRecord.save();
      return res.status(400).json({
        success: false,
        message: `Invalid OTP. ${5 - otpRecord.attempts} attempt(s) remaining.`
      });
    }

    // Correct OTP -> single-use, delete it
    await otpSchema.deleteOne({ _id: otpRecord._id });

    const resetToken = jwt.sign(
      { email: email.trim() },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );

    res.status(200).json({
      success: true,
      message: "OTP verified successfully",
      resetToken: resetToken
    });

  } catch (error) {
    console.error("OTP verification error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to verify OTP"
    });
  }
});

// ============== RESET PASSWORD ===============================
app.patch("/reset-password", otpActionLimiter, async (req, res) => {
  const { email, password, resetToken } = req.body;

  if (!email || !password || !resetToken) {
    return res.status(400).json({
      success: false,
      message: "Email, password, and reset token are required"
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: "Password must be at least 6 characters long"
    });
  }

  try {
    let decoded;
    try {
      decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    } catch (tokenError) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired reset token. Please request a new OTP."
      });
    }

    if (decoded.email !== email.trim()) {
      return res.status(400).json({
        success: false,
        message: "Invalid reset request"
      });
    }

    const user = await Users.findOne({ 
      email: { $regex: new RegExp(`^${escapeRegex(email.trim())}$`, "i") } 
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    user.password = hashedPassword;
    await user.save();

    await otpSchema.deleteMany({ email: email.trim() });

    res.status(200).json({
      success: true,
      message: "Password reset successfully. Please login with your new password."
    });

  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to reset password. Please try again."
    });
  }
});

// ================= online users =================
app.get("/admin/online-users", (req, res) => {
  try {
    const onlineStudentIds = Array.from(onlineUsers.keys());
    res.json({
      success: true,
      onlineUsers: onlineStudentIds,
      count: onlineStudentIds.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to get online users",
    });
  }
});

// Add this route temporarily to create admin user
app.post("/create-admin", async (req, res) => {
  try {
    const { name, email, password, role = "admin" } = req.body;

    const existingAdmin = await Users.findOne({
      email: { $regex: new RegExp(`^${escapeRegex(email.trim())}$`, "i") },
    });

    if (existingAdmin) {
      return res.status(400).json({
        success: false,
        message: "Admin with this email already exists",
      });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const admin = await Users.create({
      name: name.trim(),
      email: email.trim(),
      password: hashedPassword,
      role: role,
      isActive: true,
      lastLogin: null,
    });

    res.status(201).json({
      success: true,
      message: "Admin created successfully",
      user: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (error) {
    console.error("Error creating admin:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create admin",
      error: error.message,
    });
  }
});

// ================= VERIFY TOKEN ENDPOINT =================
app.get("/verify-token", authenticateToken, async (req, res) => {
  try {
    const user = await Users.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }
    res.json({
      success: true,
      role: user.role,
      name: user.name,
      id: user._id,
      email: user.email,
    });
  } catch (error) {
    console.error("Token verification error:", error);
    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});

const { Types } = mongoose;

// ================= LOGIN =================
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const user = await Users.findOne({
      email: { $regex: new RegExp(`^${escapeRegex(email.trim())}$`, "i") },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Account is deactivated. Please contact admin.",
      });
    }

    const isPasswordMatch = await bcrypt.compare(password, user.password);
    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    await Users.findByIdAndUpdate(user._id, {
      lastLogin: new Date(),
    });

    const token = generateToken(user);

    res.status(200).json({
      success: true,
      message: "Login successful",
      token: token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ================= SIGNUP =================
app.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log("signup route is called");
    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    const trimmedEmail = email.trim();

    const checkValidStudent = await ActualStudentsData.findOne({
      email: { $regex: new RegExp(`^${escapeRegex(trimmedEmail)}$`, "i") },
    });

    if (!checkValidStudent) {
      return res.status(400).json({
        success: false,
        message: "Only 3rd and 4th year students can register",
      });
    }

    const existingUser = await Users.findOne({
      email: { $regex: new RegExp(`^${escapeRegex(trimmedEmail)}$`, "i") },
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "User with this email already exists",
      });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const newUser = await Users.create({
      name: checkValidStudent.name.trim(),
      email: trimmedEmail,
      password: hashedPassword,
      role: "student",
    });

    await StudentProfile.create({
      student: newUser._id,
      studentId: checkValidStudent.id_no.trim(),
      year: checkValidStudent.year.trim(),
      profile: {
        phone: "",
        department: checkValidStudent.department.trim() || "",
        gender: checkValidStudent.gender.trim() || "",
        cgpa: 0,
        skills: [],
        projects: [],
        resume: "",
        resumeFileType: "",
        resumeFileName: "",
        bio: "",
        linkedin: "",
        github: "",
        portfolio: "",
        address: "",
        dateOfBirth: "",
        bloodGroup: "",
        profilePicture: "",
        profilePictureFileType: "",
      },
      eligible_drives: [],
      applied_drives: [],
      shortlisted_drives: [],
    });

    const token = generateToken(newUser);

    res.status(201).json({
      success: true,
      message: "Registration successful",
      token: token,
      user: {
        id: newUser._id,
        studentId: checkValidStudent.id_no.trim(),
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
      },
      studentDetails: {
        name: checkValidStudent.name.trim(),
        studentId: checkValidStudent.id_no.trim(),
        department: checkValidStudent.department.trim() || "N/A",
        gender: checkValidStudent.gender.trim() || "N/A",
        year: checkValidStudent.year.trim() || "N/A",
        email: trimmedEmail,
      },
    });
  } catch (error) {
    console.error("Signup Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ================= GET PROFILE =================
app.get("/studentyear/:id", async (req, res) => {
  try {
    const profile = await StudentProfile.findOne({ student: req.params.id });
    if (!profile) {
      return res.status(404).json({ message: "Student profile not found" });
    }
    res.json({ year: profile.year });
  } catch (err) {
    console.error("Error fetching student year:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

app.get("/studentprofile/:id", async (req, res) => {
  try {
    const profile = await StudentProfile.findOne({
      student: req.params.id,
    }).populate("student");

    if (!profile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    res.json({
      name: profile.student.name,
      email: profile.student.email,
      studentId: profile.studentId,
      profile: profile.profile,
      eligible_drives: profile.eligible_drives,
      applied_drives: profile.applied_drives,
      shortlisted_drives: profile.shortlisted_drives,
      year: profile.year,
    });
  } catch (err) {
    console.error("Profile Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

// ========================= Update student profile ===========================
app.patch("/studentprofile/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const studentUpdate = {
      name: updateData.name,
      email: updateData.email,
    };

    await Users.findByIdAndUpdate(id, studentUpdate, {
      new: true,
    });

    const profileUpdate = {
      "profile.phone": updateData.profile?.phone,
      "profile.cgpa": updateData.profile?.cgpa,
      "profile.skills": updateData.profile?.skills,
      "profile.projects": updateData.profile?.projects,
      "profile.bio": updateData.profile?.bio,
      "profile.linkedin": updateData.profile?.linkedin,
      "profile.github": updateData.profile?.github,
      "profile.portfolio": updateData.profile?.portfolio,
      "profile.address": updateData.profile?.address,
      "profile.dateOfBirth": updateData.profile?.dateOfBirth,
      "profile.bloodGroup": updateData.profile?.bloodGroup,
      "profile.profilePicture": updateData.profile?.profilePicture || "",
      "profile.profilePictureFileType":
        updateData.profile?.profilePictureFileType || "",
      "profile.resume": updateData.profile?.resume || "",
      "profile.resumeFileType": updateData.profile?.resumeFileType || "",
      "profile.resumeFileName": updateData.profile?.resumeFileName || "",
    };

    const updatedProfile = await StudentProfile.findOneAndUpdate(
      { student: id },
      { $set: profileUpdate },
      { new: true },
    ).populate("student");

    if (!updatedProfile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    res.json({
      success: true,
      message: "Profile updated successfully",
      profile: {
        name: updatedProfile.student.name,
        email: updatedProfile.student.email,
        studentId: updatedProfile.studentId,
        year: updatedProfile.year,
        profile: updatedProfile.profile,
      },
    });
  } catch (error) {
    console.error("Update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update profile",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ================= FILE UPLOADS TO MONGODB =================

const storage = multer.memoryStorage();

const fileUpload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

// Upload Profile Picture to MongoDB
app.post(
  "/uploadProfilePicture/:id",
  fileUpload.single("profilePicture"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const userId = req.params.id;
      const base64Image = req.file.buffer.toString("base64");
      const fileType = req.file.mimetype;

      const updatedProfile = await StudentProfile.findOneAndUpdate(
        { student: userId },
        {
          "profile.profilePicture": base64Image,
          "profile.profilePictureFileType": fileType,
        },
        { new: true },
      );

      if (!updatedProfile) {
        return res.status(404).json({ message: "Student profile not found" });
      }

      res.json({
        message: "Profile picture uploaded successfully.",
        profilePicture: updatedProfile.profile.profilePicture,
        fileType: updatedProfile.profile.profilePictureFileType,
      });
    } catch (err) {
      console.error("Upload error:", err);
      res.status(500).json({ message: "Upload failed", error: err.message });
    }
  },
);

// Get Profile Picture from MongoDB
app.get("/getProfilePicture/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    const profile = await StudentProfile.findOne({ student: userId });

    if (!profile || !profile.profile.profilePicture) {
      return res.status(404).json({ message: "Profile picture not found" });
    }

    const imageBuffer = Buffer.from(profile.profile.profilePicture, "base64");
    res.set(
      "Content-Type",
      profile.profile.profilePictureFileType || "image/jpeg",
    );
    res.send(imageBuffer);
  } catch (err) {
    console.error("Error fetching profile picture:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

// Upload Resume to MongoDB
app.post("/uploadResume/:id", fileUpload.single("resume"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const userId = req.params.id;
    const base64Resume = req.file.buffer.toString("base64");
    const fileType = req.file.mimetype;
    const fileName = req.file.originalname;

    const updatedProfile = await StudentProfile.findOneAndUpdate(
      { student: userId },
      {
        "profile.resume": base64Resume,
        "profile.resumeFileType": fileType,
        "profile.resumeFileName": fileName,
      },
      { new: true },
    );

    if (!updatedProfile) {
      return res.status(404).json({ message: "Student profile not found" });
    }

    res.json({
      message: "Resume uploaded successfully to MongoDB",
      resume: updatedProfile.profile.resume,
      fileType: updatedProfile.profile.resumeFileType,
      fileName: updatedProfile.profile.resumeFileName,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ message: "Upload failed", error: err.message });
  }
});

// Get Resume from MongoDB
app.get("/getResume/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    const profile = await StudentProfile.findOne({ student: userId });

    if (!profile || !profile.profile.resume) {
      return res.status(404).json({ message: "Resume not found" });
    }

    const resumeBuffer = Buffer.from(profile.profile.resume, "base64");
    res.set(
      "Content-Type",
      profile.profile.resumeFileType || "application/pdf",
    );
    res.set(
      "Content-Disposition",
      `attachment; filename="${profile.profile.resumeFileName || "resume.pdf"}"`,
    );
    res.send(resumeBuffer);
  } catch (err) {
    console.error("Error fetching resume:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

// ================= PUBLIC ROUTES =================
app.get("/companydrives", async (req, res) => {
  try {
    const drives = await CompanyDrives.find({});
    res.status(200).json(drives);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});

app.get("/departments", async (req, res) => {
  try {
    const departments = await DepartmentSchema.find({});
    res.status(200).json(departments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});

app.get("/placements", async (req, res) => {
  try {
    const yearlyPlacementsData = await YearlyPlacements.find({}).sort({ year: -1 });
    const companiesData = await Company.find({});
    const placedStudentsData = await PlacedStudents.find({});
    const departmentsData = await DepartmentSchema.find({});
    const campusStatsData = await CampusStats.find({});
    const companyDrivesData = await CompanyDrives.find({});

    res.status(200).json({
      yearlyPlacements: yearlyPlacementsData,
      companies: companiesData,
      placedStudents: placedStudentsData,
      departments: departmentsData,
      campusStats: campusStatsData,
      companyDrives: companyDrivesData,
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
});

app.get("/placedStudents", async (req, res) => {
  try {
    const data = await PlacedStudents.find({}).sort({ createdAt: -1 });
    console.log(
      "📊 Placements fetched:",
      data.map((p) => ({
        name: p.name,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    );
    res.status(200).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});

// ================= APPLY FOR DRIVE =================
app.post("/applyDrive/:studentId", async (req, res) => {
  const { studentId } = req.params;
  const { driveId } = req.body;

  try {
    if (!studentId || !driveId) {
      return res.status(400).json({
        success: false,
        message: "Student ID and Drive ID are required",
      });
    }

    if (
      !Types.ObjectId.isValid(studentId) ||
      !Types.ObjectId.isValid(driveId)
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid ID format" });
    }

    let studentProfile = await StudentProfile.findOne({ student: studentId });

    if (!studentProfile) {
      return res
        .status(404)
        .json({ success: false, message: "Student profile not found" });
    }

    if (!studentProfile.applied_drives) {
      studentProfile.applied_drives = [];
    }

    const alreadyApplied = studentProfile.applied_drives.some(
      (applied) =>
        applied.drive && applied.drive.toString() === driveId.toString(),
    );

    if (alreadyApplied) {
      return res
        .status(400)
        .json({ success: false, message: "Already applied to this drive" });
    }

    const driveExists = await CompanyDrives.findById(driveId);
    if (!driveExists) {
      return res
        .status(404)
        .json({ success: false, message: "Drive not found" });
    }

    studentProfile.applied_drives.push({
      drive: new Types.ObjectId(driveId),
      appliedAt: new Date(),
      status: "pending",
    });

    await studentProfile.save();
    await studentProfile.populate("applied_drives.drive");

    res.status(200).json({
      success: true,
      message: "Application submitted successfully",
      appliedDrives: studentProfile.applied_drives,
      appliedCount: studentProfile.applied_drives.length,
    });
  } catch (error) {
    console.error("Apply drive error:", error);
    res.status(500).json({
      success: false,
      message: "Server Error: " + error.message,
    });
  }
});

// ============== YEARLY PLACEMENTS CRUD ROUTES ==============

// GET all yearly placements
app.get("/admin/yearly-placements", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const placements = await YearlyPlacements.find({}).sort({ year: -1 });
    res.json(placements);
  } catch (error) {
    console.error("Error fetching yearly placements:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// POST - Add new yearly placement
app.post("/admin/yearly-placements", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { year, totalPlaced, totalCompanies, highestPackage, averagePackage, totalStudents } = req.body;

    // Check if year already exists
    const existing = await YearlyPlacements.findOne({ year });
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: `Year ${year} already exists` 
      });
    }

    const newPlacement = await YearlyPlacements.create({
      year,
      totalPlaced,
      totalCompanies: totalCompanies || 0,
      highestPackage: highestPackage || 0,
      averagePackage: averagePackage || 0,
      totalStudents: totalStudents || 0
    });

    res.status(201).json({
      success: true,
      message: "Yearly placement added successfully",
      data: newPlacement
    });
  } catch (error) {
    console.error("Error adding yearly placement:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server Error: " + error.message 
    });
  }
});

// PUT - Update yearly placement
app.put("/admin/yearly-placements/:id", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const { year, totalPlaced, totalCompanies, highestPackage, averagePackage, totalStudents } = req.body;

    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid ID format" 
      });
    }

    // Check if year already exists for another record
    const existing = await YearlyPlacements.findOne({ 
      year, 
      _id: { $ne: id } 
    });
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: `Year ${year} already exists for another record` 
      });
    }

    const updated = await YearlyPlacements.findByIdAndUpdate(
      id,
      {
        year,
        totalPlaced,
        totalCompanies: totalCompanies || 0,
        highestPackage: highestPackage || 0,
        averagePackage: averagePackage || 0,
        totalStudents: totalStudents || 0,
        updatedAt: new Date()
      },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({ 
        success: false, 
        message: "Yearly placement not found" 
      });
    }

    res.json({
      success: true,
      message: "Yearly placement updated successfully",
      data: updated
    });
  } catch (error) {
    console.error("Error updating yearly placement:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server Error: " + error.message 
    });
  }
});

// DELETE - Delete yearly placement
app.delete("/admin/yearly-placements/:id", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { id } = req.params;

    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid ID format" 
      });
    }

    const deleted = await YearlyPlacements.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ 
        success: false, 
        message: "Yearly placement not found" 
      });
    }

    res.json({
      success: true,
      message: "Yearly placement deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting yearly placement:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server Error: " + error.message 
    });
  }
});


// Debug endpoint
app.get("/debug/student-applications/:studentId", async (req, res) => {
  const { studentId } = req.params;
  try {
    const studentProfile = await StudentProfile.findOne({
      student: studentId,
    }).populate("applied_drives.drive");

    res.json({
      studentId: studentProfile?.studentId,
      appliedDrivesCount: studentProfile?.applied_drives?.length || 0,
      appliedDrives: studentProfile?.applied_drives.map((applied) => ({
        driveId: applied.drive?._id,
        companyName: applied.drive?.companyName,
        appliedAt: applied.appliedAt,
        status: applied.status,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= ADMIN ROUTES =================

// ---------- STUDENT ROUTES ----------
app.get("/admin/students", async (req, res) => {
  try {
    const students = await StudentProfile.find({}).populate("student");
    res.json(students);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

app.get("/admin/students/:id", async (req, res) => {
  try {
    const student = await StudentProfile.findOne({
      student: req.params.id,
    }).populate("student");
    if (!student) return res.status(404).json({ message: "Student not found" });
    res.json(student);
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
});

app.post("/admin/students", async (req, res) => {
  const { name, email, password, studentId, department, phone, cgpa, year } =
    req.body;

  try {
    if (!name || !email || !password || !studentId) {
      return res.status(400).json({
        success: false,
        message: "Name, email, password, and student ID are required",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    const validYears = ["1st", "2nd", "3rd", "4th", "1", "2", "3", "4"];
    if (year && !validYears.includes(year.toString().trim())) {
      return res.status(400).json({
        success: false,
        message: "Invalid year. Must be 1st, 2nd, 3rd, or 4th year",
      });
    }

    const trimmedEmail = email.trim();
    const trimmedYear = year ? year.toString().trim() : "4th";

    const existingUser = await Users.findOne({
      email: { $regex: new RegExp(`^${escapeRegex(trimmedEmail)}$`, "i") },
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "User with this email already exists",
      });
    }

    const existingId = await StudentProfile.findOne({
      studentId: studentId.trim(),
    });

    if (existingId) {
      return res.status(400).json({
        success: false,
        message: "Student ID already exists!",
      });
    }

    let checkValidStudent = await ActualStudentsData.findOne({
      email: { $regex: new RegExp(`^${escapeRegex(trimmedEmail)}$`, "i") },
    });

    if (!checkValidStudent) {
      try {
        checkValidStudent = await ActualStudentsData.create({
          name: name.trim(),
          email: trimmedEmail,
          id_no: studentId.trim(),
          department: department || "Not Specified",
          gender: "Not Specified",
          year: trimmedYear,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log(`📝 Created new ActualStudentsData record for ${name}`);
      } catch (createError) {
        console.error("Error creating ActualStudentsData record:", createError);
        return res.status(500).json({
          success: false,
          message: "Failed to create student record",
        });
      }
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const newStudent = await Users.create({
      name: name.trim(),
      email: trimmedEmail,
      password: hashedPassword,
      role: "student",
      isActive: true,
      createdAt: new Date(),
    });

    const studentProfile = await StudentProfile.create({
      student: newStudent._id,
      studentId: studentId.trim(),
      year: trimmedYear,
      profile: {
        phone: phone || "",
        department: department || checkValidStudent?.department || "Not Specified",
        cgpa: parseFloat(cgpa) || 0,
        skills: [],
        projects: [],
        resume: "",
        resumeFileType: "",
        resumeFileName: "",
        bio: "",
        linkedin: "",
        github: "",
        portfolio: "",
        address: "",
        dateOfBirth: "",
        gender: checkValidStudent?.gender || "",
        bloodGroup: "",
        profilePicture: "",
        profilePictureFileType: "",
      },
      eligible_drives: [],
      applied_drives: [],
      shortlisted_drives: [],
    });

    res.status(201).json({
      success: true,
      message: "Student added successfully",
      student: {
        id: newStudent._id,
        name: newStudent.name,
        email: newStudent.email,
        studentId: studentProfile.studentId,
        department: studentProfile.profile.department,
        year: studentProfile.year,
        cgpa: studentProfile.profile.cgpa,
      },
    });
  } catch (error) {
    console.error("❌ Error adding student:", error);
    res.status(500).json({
      success: false,
      message: "Server Error: " + error.message,
    });
  }
});

app.patch("/admin/students/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid student ID format" });
    }

    const userUpdate = {
      name: updateData.name,
      email: updateData.email,
    };

    await Users.findByIdAndUpdate(id, userUpdate);

    const profileUpdate = {
      studentId: updateData.studentId,
      "profile.department": updateData.department,
      "profile.phone": updateData.phone,
      "profile.cgpa": parseFloat(updateData.cgpa) || 0,
    };

    const updatedProfile = await StudentProfile.findOneAndUpdate(
      { student: id },
      { $set: profileUpdate },
      { new: true },
    ).populate("student");

    if (!updatedProfile) {
      return res.status(404).json({ message: "Student profile not found" });
    }

    res.json({
      message: "Student updated successfully",
      student: updatedProfile,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error: " + error.message });
  }
});

app.delete("/admin/students/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid student ID format" });
    }

    const student = await Users.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    await Users.findByIdAndDelete(id);
    await StudentProfile.findOneAndDelete({ student: id });

    res.status(200).json({ message: "Student deleted successfully" });
  } catch (error) {
    console.error("Delete student error:", error);
    res.status(500).json({ message: "Server Error: " + error.message });
  }
});

// ================= DEPARTMENT STUDENT STATS =================

app.get(
  "/admin/students/department-stats",
  authenticateToken,
  async (req, res) => {
    try {
      const students = await StudentProfile.find({}).populate("student");

      const departmentStats = {};
      const departmentStudents = {};

      students.forEach((student) => {
        const department = student.profile?.department || "Not Specified";

        if (!departmentStats[department]) {
          departmentStats[department] = 0;
          departmentStudents[department] = [];
        }
        departmentStats[department]++;

        departmentStudents[department].push({
          id: student._id,
          name: student.student?.name || "Unknown",
          email: student.student?.email || "No email",
          studentId: student.studentId || "N/A",
          year: student.year || "N/A",
          cgpa: student.profile?.cgpa || 0,
          registeredAt:
            student.createdAt || student.student?.createdAt || new Date(),
        });
      });

      const sortedDepartments = Object.keys(departmentStats).sort();
      const result = {};
      sortedDepartments.forEach((dept) => {
        result[dept] = {
          count: departmentStats[dept],
          students: departmentStudents[dept] || [],
        };
      });

      res.json({
        success: true,
        totalStudents: students.length,
        departments: result,
        departmentNames: sortedDepartments,
        departmentCounts: sortedDepartments.map((dept) => ({
          name: dept,
          count: departmentStats[dept],
        })),
      });
    } catch (error) {
      console.error("Error fetching department stats:", error);
      res.status(500).json({
        success: false,
        message: "Server Error: " + error.message,
      });
    }
  },
);

app.get("/admin/students/department/:department", async (req, res) => {
  try {
    const { department } = req.params;

    const students = await StudentProfile.find({
      "profile.department": { $regex: new RegExp(`^${escapeRegex(department)}$`, "i") },
    }).populate("student");

    res.json({
      success: true,
      department: department,
      count: students.length,
      students: students.map((student) => ({
        id: student._id,
        name: student.student?.name || "Unknown",
        email: student.student?.email || "No email",
        studentId: student.studentId || "N/A",
        year: student.year || "N/A",
        cgpa: student.profile?.cgpa || 0,
        phone: student.profile?.phone || "N/A",
        registeredAt:
          student.createdAt || student.student?.createdAt || new Date(),
      })),
    });
  } catch (error) {
    console.error("Error fetching department students:", error);
    res.status(500).json({
      success: false,
      message: "Server Error: " + error.message,
    });
  }
});

app.get("/admin/departments/stats-full", async (req, res) => {
  try {
    const students = await StudentProfile.find({}).populate("student");
    const placements = await PlacedStudents.find({});

    const departmentStats = {};
    const departmentStudents = {};
    const departmentPlacements = {};

    students.forEach((student) => {
      const department = student.profile?.department || "Not Specified";

      if (!departmentStats[department]) {
        departmentStats[department] = 0;
        departmentStudents[department] = [];
        departmentPlacements[department] = [];
      }
      departmentStats[department]++;
      departmentStudents[department].push({
        id: student._id,
        name: student.student?.name || "Unknown",
        email: student.student?.email || "No email",
        studentId: student.studentId || "N/A",
        year: student.year || "N/A",
        cgpa: student.profile?.cgpa || 0,
        registeredAt:
          student.createdAt || student.student?.createdAt || new Date(),
      });
    });

    placements.forEach((placement) => {
      const department = placement.department || "Not Specified";
      if (departmentPlacements[department]) {
        departmentPlacements[department].push({
          name: placement.name,
          company: placement.company,
          package: placement.package,
          year: placement.year,
        });
      }
    });

    const sortedDepartments = Object.keys(departmentStats).sort();
    const result = {};
    sortedDepartments.forEach((dept) => {
      result[dept] = {
        studentCount: departmentStats[dept],
        students: departmentStudents[dept],
        placementCount: departmentPlacements[dept]?.length || 0,
        placements: departmentPlacements[dept] || [],
      };
    });

    res.json({
      success: true,
      totalStudents: students.length,
      totalPlacements: placements.length,
      departments: result,
      departmentNames: sortedDepartments,
      departmentCounts: sortedDepartments.map((dept) => ({
        name: dept,
        studentCount: departmentStats[dept],
        placementCount: departmentPlacements[dept]?.length || 0,
      })),
    });
  } catch (error) {
    console.error("Error fetching full department stats:", error);
    res.status(500).json({
      success: false,
      message: "Server Error: " + error.message,
    });
  }
});

app.get("/admin/departments/placement-stats", async (req, res) => {
  try {
    const placements = await PlacedStudents.find({});
    const students = await StudentProfile.find({});

    const deptStats = {};

    students.forEach((student) => {
      const dept = student.profile?.department || "Not Specified";
      if (!deptStats[dept]) {
        deptStats[dept] = {
          totalStudents: 0,
          placedStudents: 0,
          placements: [],
        };
      }
      deptStats[dept].totalStudents++;
    });

    placements.forEach((placement) => {
      const dept = placement.department || "Not Specified";
      if (deptStats[dept]) {
        deptStats[dept].placedStudents++;
        deptStats[dept].placements.push(placement);
      } else {
        deptStats[dept] = {
          totalStudents: 0,
          placedStudents: 1,
          placements: [placement],
        };
      }
    });

    const result = {};
    Object.keys(deptStats).forEach((dept) => {
      const data = deptStats[dept];
      result[dept] = {
        ...data,
        placementRate:
          data.totalStudents > 0
            ? ((data.placedStudents / data.totalStudents) * 100).toFixed(1)
            : "0",
      };
    });

    res.json({
      success: true,
      departments: result,
    });
  } catch (error) {
    console.error("Error fetching placement stats:", error);
    res.status(500).json({
      success: false,
      message: "Server Error: " + error.message,
    });
  }
});

app.get("/admin/students/recent", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;

    const students = await StudentProfile.find({})
      .populate("student")
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({
      success: true,
      count: students.length,
      students: students.map((student) => ({
        id: student._id,
        name: student.student?.name || "Unknown",
        email: student.student?.email || "No email",
        studentId: student.studentId || "N/A",
        department: student.profile?.department || "Not Specified",
        year: student.year || "N/A",
        cgpa: student.profile?.cgpa || 0,
        registeredAt:
          student.createdAt || student.student?.createdAt || new Date(),
      })),
    });
  } catch (error) {
    console.error("Error fetching recent students:", error);
    res.status(500).json({
      success: false,
      message: "Server Error: " + error.message,
    });
  }
});

// ---------- DRIVE ROUTES ----------
app.post("/admin/drives", async (req, res) => {
  try {
    console.log("📝 Creating drive with data:", req.body);

    if (!req.body.companyName) {
      return res.status(400).json({
        success: false,
        message: "Company name is required",
      });
    }

    const driveData = {
      companyName: req.body.companyName.trim(),
      roles: req.body.roles ? req.body.roles.trim() : "",
      package: req.body.package || "Not Disclosed",
      location: req.body.location || "Multiple Locations",
      date: req.body.date || null,
      status: req.body.status || "upcoming",
      description: req.body.description || "",
      eligibility: req.body.eligibility || "",
      googleFormLink: req.body.googleFormLink || "",
      type: req.body.type || "On-Campus",
      studentsSelected: req.body.studentsSelected || 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    console.log("📝 Saving drive data:", driveData);

    const drive = await CompanyDrives.create(driveData);

    console.log("✅ Drive created successfully:", drive);

    sendDriveNotificationEmails(driveData).catch((error) => {
      console.error("❌ Error sending email notifications:", error);
    });

    res.status(201).json({
      success: true,
      message: "Drive created successfully",
      drive,
    });
  } catch (error) {
    console.error("❌ Error creating drive:", error);
    res.status(500).json({
      success: false,
      message: "Server Error: " + error.message,
    });
  }
});

// ================= EMAIL SENDING FUNCTION WITH RETRY AND SENDGRID FALLBACK ================================

// Helper function to send email using multiple methods with IPv4 enforcement
async function sendEmail({ to, subject, html }) {
  const failures = [];

  const trySendVia = async (name, fn) => {
    try {
      console.log(`📧 Sending email to ${to} via ${name}...`);
      const info = await fn();
      console.log(`✅ Email sent via ${name} to ${to}`);
      return { success: true, method: name, info };
    } catch (error) {
      console.log(`❌ ${name} failed for ${to}: ${error.message}`);
      failures.push(`${name}: ${error.message}`);
      return null;
    }
  };

  // 1) Brevo REST API over IPv4 (if BREVO_API_KEY configured)
  if (process.env.BREVO_API_KEY) {
    const apiResult = await trySendVia("brevo-api-ipv4", () =>
      sendBrevoApiEmail({ to, subject, html })
    );
    if (apiResult) return apiResult;
  }

  // 2) Primary SMTP provider (Brevo SMTP or Gmail SMTP with IPv4 family forced)
  if (transporter) {
    const smtpResult = await trySendVia(
      process.env.BREVO_API_KEY ? "brevo-smtp-ipv4" : "gmail-smtp-ipv4",
      () =>
        transporter.sendMail({
          from: process.env.EMAIL,
          to: to,
          subject: subject,
          html: html,
        })
    );
    if (smtpResult) return smtpResult;
  }

  // 3) Gmail fallback (when Brevo was primary)
  if (gmailFallback) {
    const fallbackResult = await trySendVia("gmail-fallback-ipv4", () =>
      gmailFallback.sendMail({
        from: process.env.EMAIL,
        to: to,
        subject: subject,
        html: html,
      })
    );
    if (fallbackResult) return fallbackResult;
  }

  // 4) SendGrid last resort (if configured)
  if (sgMail && process.env.SENDGRID_API_KEY) {
    const sgResult = await trySendVia("sendgrid-ipv4", () =>
      sgMail.send({ to, from: process.env.EMAIL, subject, html })
    );
    if (sgResult) return sgResult;
  }

  throw new Error(`All email providers failed -> ${failures.join(" | ")}`);
}

// Function to send email with retry
async function sendEmailWithRetry(student, subject, html, retryCount = 0) {
  const maxRetries = 3;
  const delay = 2000 * (retryCount + 1);

  try {
    console.log(`📤 Attempting to send email to ${student.email} (attempt ${retryCount + 1})`);
    
    const result = await sendEmail({
      to: student.email,
      subject: subject,
      html: html,
    });
    
    console.log(`✅ Email sent to ${student.email} via ${result.method}`);
    return { success: true, student: student.email, method: result.method };
  } catch (error) {
    console.error(`❌ Failed to send email to ${student.email} (attempt ${retryCount + 1})`);
    console.error("Error code:", error.code || error.response?.status);
    console.error("Error message:", error.message);
    
    if (retryCount < maxRetries) {
      console.log(`🔄 Retrying ${student.email} in ${delay/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendEmailWithRetry(student, subject, html, retryCount + 1);
    }
    
    return { success: false, student: student.email, error: error.message };
  }
}

async function sendDriveNotificationEmails(driveData) {
  try {
    console.log("📧 Starting to send drive notification emails...");

    const students = await Users.find({ role: "student" }, "name email");
    if (!students || students.length === 0) {
      console.log("⚠️ No students found to send notifications");
      return;
    }

    console.log(`📧 Found ${students.length} students to send notifications`);
    console.log(`📧 Using email: ${process.env.EMAIL}`);
    console.log(`📧 Email password set: ${!!process.env.EMAIL_PASSWORD}`);
    if (sgMail && process.env.SENDGRID_API_KEY) {
      console.log(`📧 SendGrid fallback: ✅ Available`);
    } else {
      console.log(`📧 SendGrid fallback: ❌ Not configured`);
    }

    // Format the date for email
    const driveDate = driveData.date
      ? new Date(driveData.date).toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "Not specified";

    // Prepare email content
    const emailSubject = `🚀 New Placement Drive: ${driveData.companyName}`;
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f9f9f9; border-radius: 10px;">
        <div style="background: linear-gradient(135deg, #1a56db, #7c3aed); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">🚀 New Placement Drive</h1>
        </div>
        
        <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h2 style="color: #1a56db; margin-top: 0;">${driveData.companyName}</h2>
          
          <p style="color: #4a5568; line-height: 1.6;">Dear Student,</p>
          <p style="color: #4a5568; line-height: 1.6;">A new placement drive has been announced. Below are the details:</p>
          
          <div style="background: #f7fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 8px 0;"><strong>🏢 Company:</strong> ${driveData.companyName}</p>
            <p style="margin: 8px 0;"><strong>💼 Role:</strong> ${driveData.roles || "Multiple roles available"}</p>
            <p style="margin: 8px 0;"><strong>💰 Package:</strong> ${driveData.package || "Not disclosed"}</p>
            <p style="margin: 8px 0;"><strong>📍 Location:</strong> ${driveData.location || "Multiple locations"}</p>
            <p style="margin: 8px 0;"><strong>📅 Date:</strong> ${driveDate}</p>
            ${driveData.eligibility ? `<p style="margin: 8px 0;"><strong>📋 Eligibility:</strong> ${driveData.eligibility}</p>` : ""}
            ${driveData.description ? `<p style="margin: 8px 0;"><strong>📝 Description:</strong> ${driveData.description}</p>` : ""}
          </div>
          
          <div style="background: #ebf8ff; border-left: 4px solid #1a56db; padding: 15px; margin: 20px 0;">
            <p style="margin: 0; color: #2b6cb0; font-size: 14px;">
              <strong>📌 How to Apply:</strong><br/>
              1. Login to the TNPC Portal<br/>
              2. Navigate to "Placement Drives" section<br/>
              3. Find this drive and click "Apply"<br/>
              4. Submit your application before the deadline
            </p>
          </div>
          
          ${
            driveData.googleFormLink
              ? `
            <div style="text-align: center; margin: 25px 0;">
              <a href="${driveData.googleFormLink}" 
                 style="background: #1a56db; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
                🔗 Apply Now
              </a>
            </div>
          `
              : ""
          }
          
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
          
          <p style="color: #718096; font-size: 14px; text-align: center;">
            This is an automated notification from TNPC Portal.<br/>
            Please login to the portal for more details and to apply.
          </p>
          
          <div style="text-align: center; margin-top: 20px;">
            <a href="${process.env.FRONTEND_URL || "http://localhost:5173"}" 
               style="color: #1a56db; text-decoration: underline; font-size: 14px;">
              Visit TNPC Portal
            </a>
          </div>
        </div>
      </div>
    `;

    const batchSize = 10;
    let successCount = 0;
    let failCount = 0;
    const results = [];

    for (let i = 0; i < students.length; i += batchSize) {
      const batch = students.slice(i, i + batchSize);
      
      console.log(`📤 Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(students.length / batchSize)}`);

      for (const student of batch) {
        if (!student.email) {
          console.log(`⚠️ Skipping student ${student.name} - no email`);
          continue;
        }

        if (results.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const result = await sendEmailWithRetry(student, emailSubject, emailHtml);
        results.push(result);
        if (result.success) {
          successCount++;
        } else {
          failCount++;
        }
      }

      if (i + batchSize < students.length) {
        console.log(`⏳ Waiting 3 seconds before next batch...`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    console.log(`✅ Email notifications completed`);
    console.log(`📊 Summary: ${successCount} sent, ${failCount} failed, ${students.length} total students`);

    const failedEmails = results.filter(r => !r.success);
    if (failedEmails.length > 0) {
      console.warn(`⚠️ Failed emails:`, failedEmails.map(r => r.student));
    }
  } catch (error) {
    console.error("❌ Error in sendDriveNotificationEmails:", error);
    throw error;
  }
}

// Optional: Endpoint to test email sending
app.post("/admin/test-email", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    console.log(`📧 Testing email to: ${email}`);
    console.log(`📧 Using EMAIL: ${process.env.EMAIL}`);
    console.log(`📧 EMAIL_PASSWORD set: ${!!process.env.EMAIL_PASSWORD}`);
    console.log(`📧 SendGrid available: ${!!sgMail && !!process.env.SENDGRID_API_KEY}`);

    const result = await sendEmail({
      to: email,
      subject: "Test Email from TNPC Portal",
      html: `
        <h2>Test Email</h2>
        <p>This is a test email from the TNPC Portal.</p>
        <p>If you're receiving this, the email configuration is working correctly!</p>
        <p>Timestamp: ${new Date().toISOString()}</p>
        <p>Method: ${result.method || 'unknown'}</p>
      `,
    });

    console.log(`✅ Test email sent successfully to ${email} via ${result.method}`);

    res.json({
      success: true,
      message: `Test email sent to ${email}`,
      method: result.method,
      info: result.info
    });
  } catch (error) {
    console.error("❌ Test email error:", error);
    
    res.status(500).json({
      success: false,
      message: "Failed to send test email",
      error: error.message,
      code: error.code || error.response?.status
    });
  }
});

app.patch("/admin/drives/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    console.log("📝 Updating drive with data:", updateData);

    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid drive ID format",
      });
    }

    const updateFields = {};

    if (updateData.companyName !== undefined)
      updateFields.companyName = updateData.companyName.trim();
    if (updateData.roles !== undefined)
      updateFields.roles = updateData.roles.trim();
    if (updateData.package !== undefined)
      updateFields.package = updateData.package;
    if (updateData.location !== undefined)
      updateFields.location = updateData.location;
    if (updateData.date !== undefined) updateFields.date = updateData.date;
    if (updateData.status !== undefined)
      updateFields.status = updateData.status;
    if (updateData.description !== undefined)
      updateFields.description = updateData.description;
    if (updateData.eligibility !== undefined)
      updateFields.eligibility = updateData.eligibility;

    updateFields.updatedAt = new Date();

    const existingDrive = await CompanyDrives.findById(id);
    if (!existingDrive) {
      return res.status(404).json({
        success: false,
        message: "Drive not found",
      });
    }

    const drive = await CompanyDrives.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { new: true, runValidators: true },
    );

    console.log("✅ Drive updated successfully:", drive);

    res.json({
      success: true,
      message: "Drive updated successfully",
      drive,
    });
  } catch (error) {
    console.error("❌ Error updating drive:", error);
    res.status(500).json({
      success: false,
      message: "Server Error: " + error.message,
    });
  }
});

app.delete("/admin/drives/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid drive ID format",
      });
    }

    const deleted = await CompanyDrives.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Drive not found",
      });
    }

    res.json({
      success: true,
      message: "Drive deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting drive:", error);
    res.status(500).json({
      success: false,
      message: "Server Error: " + error.message,
    });
  }
});

// ---------- PLACEMENT ROUTES ----------
app.get("/admin/placements", async (req, res) => {
  try {
    const placements = await PlacedStudents.find({}).sort({ createdAt: -1 });
    res.json(placements);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

app.post("/admin/placements", async (req, res) => {
  try {
    const { name, company, package: pkg, department, year } = req.body;
    const newPlacement = await PlacedStudents.create({
      name,
      company,
      package: pkg,
      department,
      year: year || new Date().getFullYear(),
    });

    res.status(201).json({
      message: "Placement added successfully",
      placement: newPlacement,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

app.delete("/admin/placements/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid placement ID format" });
    }
    const deleted = await PlacedStudents.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ message: "Placement not found" });
    }
    res.json({ message: "Placement deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

app.get("/debug/placements", async (req, res) => {
  try {
    const placements = await PlacedStudents.find({});
    const debugData = placements.map((p) => ({
      id: p._id,
      name: p.name,
      company: p.company,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      hasCreatedAt: !!p.createdAt,
      type: typeof p.createdAt,
    }));
    res.json({
      count: placements.length,
      placements: debugData,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/// ==================== Department-Stats ====================
app.get("/admin/department/stats", authenticateToken, async (req, res) => {
  try {
    const students = await StudentProfile.find({}).populate("student").lean();
    const placements = await PlacedStudents.find({}).lean();

    const departmentMapping = {
      CSE: "Computer Science & Engineering",
      CS: "Computer Science & Engineering",
      "Computer Science": "Computer Science & Engineering",
      "Computer Science and Engineering": "Computer Science & Engineering",
      ECE: "Electronics & Communication Engineering",
      Electronics: "Electronics & Communication Engineering",
      "Electronics and Communication": "Electronics & Communication Engineering",
      EEE: "Electrical & Electronics Engineering",
      Electrical: "Electrical & Electronics Engineering",
      "Electrical and Electronics": "Electrical & Electronics Engineering",
      MECH: "Mechanical Engineering",
      Mechanical: "Mechanical Engineering",
      CIVIL: "Civil Engineering",
      Civil: "Civil Engineering",
      METALLURGY: "Metallurgical Engineering",
      Metallurgy: "Metallurgical Engineering",
      Metallurgical: "Metallurgical Engineering",
      AI: "Artificial Intelligence & Machine Learning",
      ML: "Artificial Intelligence & Machine Learning",
      "AI/ML": "Artificial Intelligence & Machine Learning",
      AIML: "Artificial Intelligence & Machine Learning",
      "Artificial Intelligence": "Artificial Intelligence & Machine Learning",
      "Machine Learning": "Artificial Intelligence & Machine Learning",
    };

    const reverseMapping = {
      "Computer Science & Engineering": "CSE",
      "Electronics & Communication Engineering": "ECE",
      "Electrical & Electronics Engineering": "EEE",
      "Mechanical Engineering": "MECH",
      "Civil Engineering": "CIVIL",
      "Metallurgical Engineering": "METALLURGY",
      "Artificial Intelligence & Machine Learning": "AIML",
    };

    const normalizeDepartment = (dept) => {
      if (!dept) return "Not Specified";
      const trimmed = dept.trim();
      return departmentMapping[trimmed] || trimmed;
    };

    const getDisplayDepartment = (dept) => {
      return reverseMapping[dept] || dept;
    };

    const departmentStats = {};
    const incompleteProfiles = [];
    const notSpecifiedStudents = [];

    placements.forEach((placement) => {
      const department = normalizeDepartment(placement.department);

      if (!departmentStats[department]) {
        departmentStats[department] = {
          department: department,
          displayName: getDisplayDepartment(department),
          totalStudents: 0,
          placedStudents: 0,
          totalCGPA: 0,
          students: [],
          placements: [],
        };
      }

      departmentStats[department].placedStudents++;
      departmentStats[department].placements.push({
        name: placement.name || "Unknown",
        company: placement.company || "Unknown",
        package: placement.package || "N/A",
        year: placement.year || new Date().getFullYear(),
      });
    });

    let totalStudentsCount = 0;
    let studentsWithValidCGPA = 0;

    students.forEach((student) => {
      const department = normalizeDepartment(student.profile?.department);
      const cgpa = student.profile?.cgpa || 0;

      totalStudentsCount++;

      if (cgpa > 0) {
        studentsWithValidCGPA++;
      }

      const hasIssue = !student.profile || !student.student || cgpa === 0;
      if (hasIssue) {
        let issue = "";
        if (!student.profile) issue = "Missing Profile";
        else if (!student.student) issue = "Missing Student Reference";
        else if (cgpa === 0) issue = "CGPA Not Set";
        else issue = "Incomplete Profile";

        incompleteProfiles.push({
          id: student._id,
          name: student.student?.name || "Unknown",
          email: student.student?.email || "No email",
          studentId: student.studentId || "N/A",
          year: student.year || "N/A",
          cgpa: cgpa,
          department: student.profile?.department || "Not Specified",
          issue: issue,
        });
      }

      if (
        !student.profile?.department ||
        student.profile.department.trim() === ""
      ) {
        notSpecifiedStudents.push({
          id: student._id,
          name: student.student?.name || "Unknown",
          email: student.student?.email || "No email",
          studentId: student.studentId || "N/A",
          year: student.year || "N/A",
          cgpa: cgpa,
        });
      }

      if (!departmentStats[department]) {
        departmentStats[department] = {
          department: department,
          displayName: getDisplayDepartment(department),
          totalStudents: 0,
          placedStudents: 0,
          totalCGPA: 0,
          students: [],
          placements: [],
        };
      }

      departmentStats[department].totalStudents++;

      if (cgpa > 0) {
        departmentStats[department].totalCGPA += cgpa;
      }

      departmentStats[department].students.push({
        id: student._id,
        name: student.student?.name || "Unknown",
        email: student.student?.email || "No email",
        studentId: student.studentId || "N/A",
        year: student.year || "N/A",
        cgpa: cgpa,
        issue: hasIssue ? "Incomplete" : undefined,
      });
    });

    if (notSpecifiedStudents.length > 0 || incompleteProfiles.length > 0) {
      if (!departmentStats["Not Specified"]) {
        departmentStats["Not Specified"] = {
          department: "Not Specified",
          displayName: "Not Specified",
          totalStudents: 0,
          placedStudents: 0,
          totalCGPA: 0,
          students: [],
          placements: [],
        };
      }
    }

    const sortedDepartments = Object.values(departmentStats)
      .map((dept) => {
        const studentsWithCGPA = dept.students.filter((s) => s.cgpa > 0);
        const avgCGPA =
          studentsWithCGPA.length > 0
            ? parseFloat((dept.totalCGPA / studentsWithCGPA.length).toFixed(2))
            : 0;

        const placementPercentage =
          dept.totalStudents > 0
            ? parseFloat(
                ((dept.placedStudents / dept.totalStudents) * 100).toFixed(1),
              )
            : 0;

        const sortedPlacements = [...dept.placements].sort(
          (a, b) => b.year - a.year,
        );

        const sortedStudents = [...dept.students].sort(
          (a, b) => b.cgpa - a.cgpa,
        );

        return {
          department: dept.department,
          displayName: dept.displayName,
          totalStudents: dept.totalStudents,
          placedStudents: dept.placedStudents,
          placementPercentage: placementPercentage,
          averageCGPA: avgCGPA,
          students: sortedStudents,
          placements: sortedPlacements,
        };
      })
      .filter((dept) => {
        if (dept.department === "Not Specified") {
          return dept.students.length > 0 || dept.placements.length > 0;
        }
        return dept.totalStudents > 0 || dept.placedStudents > 0;
      })
      .sort((a, b) => {
        if (a.department === "Not Specified") return 1;
        if (b.department === "Not Specified") return -1;
        return b.placementPercentage - a.placementPercentage;
      });

    res.json({
      success: true,
      totalStudents: totalStudentsCount,
      studentsWithValidCGPA: studentsWithValidCGPA,
      totalPlacements: placements.length,
      totalDepartments: sortedDepartments.length,
      summary: {
        totalStudents: totalStudentsCount,
        studentsWithValidCGPA: studentsWithValidCGPA,
        totalIncompleteProfiles: incompleteProfiles.length,
        totalNotSpecifiedDepartment: notSpecifiedStudents.length,
        totalPlacements: placements.length,
      },
      departments: sortedDepartments,
    });
  } catch (error) {
    console.error("Error fetching department stats:", error);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ======================================
app.post("/upload-actual-students", upload.single("file"), async (req, res) => {
  console.log("Uploading actual-students route is called");
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }
    const validTypes = [
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];

    if (!validTypes.includes(req.file.mimetype)) {
      return res.status(400).json({
        success: false,
        message: "Invalid file type. Please upload CSV or Excel file (.csv, .xls, .xlsx)",
      });
    }
    let data = [];
    const workbook = XLSX.read(req.file.buffer);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const parsedData = XLSX.utils.sheet_to_json(sheet);
    data = parsedData;
    console.log(data);
    const response = await ActualStudentsData.insertMany(data);
    if (!response) {
      return res.status(400).json({ message: "cannot insert" });
    }
    res.json({
      success: true,
      message: "File uploaded successfully",
      data: data,
    });
  } catch (error) {
    return res.status(500).json({ message: "Server Error" });
  }
});

// =================== UPLOADING EXCEL (OR) CSV FILE ====================
app.post(
  "/admin/upload-placements",
  authenticateToken,
  authorizeRoles("admin"),
  upload.single("file"),
  async (req, res) => {
    console.log("📤 File upload request received");
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No file uploaded",
        });
      }

      const validTypes = [
        "text/csv",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ];

      if (!validTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
          success: false,
          message: "Invalid file type. Please upload CSV or Excel file (.csv, .xls, .xlsx)",
        });
      }

      let data = [];
      try {
        const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        data = XLSX.utils.sheet_to_json(sheet);
      } catch (parseError) {
        return res.status(400).json({
          success: false,
          message: "Failed to parse file. Please ensure it's a valid CSV or Excel file.",
        });
      }

      if (data.length === 0) {
        return res.status(400).json({
          success: false,
          message: "File is empty. Please add data to the file.",
        });
      }

      const requiredColumns = ["Name", "Company"];
      const firstRow = data[0];
      const columns = Object.keys(firstRow);

      const missingColumns = requiredColumns.filter(
        (col) => !columns.some((c) => c.toLowerCase() === col.toLowerCase()),
      );

      if (missingColumns.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Missing required columns: ${missingColumns.join(", ")}. Please include 'Name' and 'Company' columns.`,
          requiredColumns: requiredColumns,
          foundColumns: columns,
        });
      }

      const results = [];
      const errors = [];
      let successCount = 0;
      let failCount = 0;

      for (let index = 0; index < data.length; index++) {
        const row = data[index];

        try {
          const name =
            row["Name"] ||
            row["name"] ||
            row["Student Name"] ||
            row["studentName"];
          const company =
            row["Company"] ||
            row["company"] ||
            row["Company Name"] ||
            row["companyName"];
          const packageAmount =
            row["Package"] ||
            row["package"] ||
            row["Package (LPA)"] ||
            row["packageLPA"] ||
            row["Package(LPA)"];
          const department =
            row["Department"] ||
            row["department"] ||
            row["Branch"] ||
            row["branch"];
          const year =
            row["Year"] ||
            row["year"] ||
            row["Placement Year"] ||
            row["placementYear"];

          if (!name || !company) {
            errors.push({
              row: index + 2,
              data: row,
              error: "Name and Company are required fields with no empty values",
            });
            failCount++;
            continue;
          }

          if (typeof name !== "string" || name.trim() === "") {
            errors.push({
              row: index + 2,
              data: row,
              error: "Name cannot be empty",
            });
            failCount++;
            continue;
          }

          if (typeof company !== "string" || company.trim() === "") {
            errors.push({
              row: index + 2,
              data: row,
              error: "Company cannot be empty",
            });
            failCount++;
            continue;
          }

          let pkgValue = 0;
          if (packageAmount) {
            pkgValue = parseFloat(packageAmount);
            if (isNaN(pkgValue) || pkgValue < 0) {
              errors.push({
                row: index + 2,
                data: row,
                error: `Invalid package value: ${packageAmount}. Must be a positive number.`,
              });
              failCount++;
              continue;
            }
          }

          let yearValue = new Date().getFullYear();
          if (year) {
            const parsedYear = parseInt(year);
            if (
              !isNaN(parsedYear) &&
              parsedYear > 2000 &&
              parsedYear <= new Date().getFullYear() + 1
            ) {
              yearValue = parsedYear;
            } else {
              errors.push({
                row: index + 2,
                data: row,
                error: `Invalid year: ${year}. Using current year instead.`,
              });
            }
          }

          const existingPlacement = await PlacedStudents.findOne({
            name: name.trim(),
            company: company.trim(),
          });

          if (existingPlacement) {
            errors.push({
              row: index + 2,
              data: row,
              error: `Duplicate entry: ${name.trim()} already placed at ${company.trim()}`,
            });
            failCount++;
            continue;
          }

          await PlacedStudents.create({
            name: name.trim(),
            company: company.trim(),
            package: pkgValue,
            department: department ? department.trim() : "Not Specified",
            year: yearValue,
            uploadedBy: req.user.id,
          });

          successCount++;
          results.push({
            row: index + 2,
            name: name.trim(),
            company: company.trim(),
            package: pkgValue,
            department: department ? department.trim() : "Not Specified",
            year: yearValue,
            status: "success",
          });
        } catch (rowError) {
          console.error(`Error processing row ${index + 2}:`, rowError);
          errors.push({
            row: index + 2,
            data: row,
            error: rowError.message || "Failed to process row",
          });
          failCount++;
        }
      }

      const response = {
        success: true,
        message: `Upload completed: ${successCount} inserted, ${failCount} failed`,
        summary: {
          total: data.length,
          success: successCount,
          failed: failCount,
        },
      };

      if (successCount > 0) {
        response.inserted = successCount;
      }

      if (errors.length > 0) {
        response.errors = errors.slice(0, 20);
        if (errors.length > 20) {
          response.message += ` (Showing first 20 errors out of ${errors.length})`;
        }
      }

      res.status(200).json(response);
    } catch (error) {
      console.error("❌ Error uploading file:", error);
      res.status(500).json({
        success: false,
        message: "Server Error: " + error.message,
      });
    }
  },
);

// Download template endpoint
app.get(
  "/admin/download-placement",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const workbook = XLSX.utils.book_new();

      const data = await PlacedStudents.find({}).lean();

      const worksheet = XLSX.utils.json_to_sheet(data);

      worksheet["!cols"] = [
        { wch: 25 },
        { wch: 25 },
        { wch: 18 },
        { wch: 35 },
        { wch: 12 },
      ];

      XLSX.utils.book_append_sheet(workbook, worksheet, "Placements");

      const instructions = [
        ["Instructions for Uploading Placements"],
        [""],
        ["1. Required columns: Name and Company (marked with *)"],
        ["2. Package should be in LPA (Lakhs Per Annum)"],
        ["3. Department should match existing departments"],
        ["4. Year should be a valid year (e.g., 2024)"],
        ["5. File must be in .xlsx, .xls, or .csv format"],
        ["6. Maximum file size: 10MB"],
        ["7. Duplicate entries (same name + company) will be skipped"],
        [""],
        ["Supported Departments:"],
        ["- Computer Science & Engineering"],
        ["- Electronics & Communication Engineering"],
        ["- Mechanical Engineering"],
        ["- Civil Engineering"],
        ["- Electrical & Electronics Engineering"],
        ["- Artificial Intelligence & Machine Learning"],
      ];

      const instructionSheet = XLSX.utils.aoa_to_sheet(instructions);
      XLSX.utils.book_append_sheet(workbook, instructionSheet, "Instructions");

      const buffer = XLSX.write(workbook, {
        type: "buffer",
        bookType: "xlsx",
      });

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=placement_template_${new Date().toISOString().split("T")[0]}.xlsx`,
      );
      res.send(buffer);
    } catch (error) {
      console.error("❌ Error generating template:", error);
      res.status(500).json({
        success: false,
        message: "Failed to generate template: " + error.message,
      });
    }
  },
);

// ================= ERROR HANDLING MIDDLEWARE =================
app.use((err, req, res, next) => {
  console.error("❌ Error:", err);
  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

// ================= 404 HANDLER =================
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`🔌 Socket.IO is ready`);
  console.log(`📧 Email configuration: ${process.env.EMAIL ? '✅ Set' : '❌ Missing'}`);
  console.log(`🔑 Email password: ${process.env.EMAIL_PASSWORD ? '✅ Set' : '❌ Missing'}`);
  console.log(`📦 MongoDB: ${process.env.MONGOURL ? '✅ Set' : '❌ Missing'}`);
  console.log(`📧 SendGrid: ${process.env.SENDGRID_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
});